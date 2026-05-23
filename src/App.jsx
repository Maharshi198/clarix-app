import { useState, useCallback, useRef, useEffect } from "react";
import Papa from "papaparse";

// ─── DATA CLEANING PIPELINE ───────────────────────────────────────────────────
// Runs automatically on every uploaded CSV before it reaches the metric engine.
// Returns { data, issues } where issues is an array of human-readable fix notes.

function cleanCSVData(rawData, fileName) {
  if (!rawData || rawData.length === 0) return { data: [], issues: [] };
  const issues = [];

  // ── STEP 1: Normalize headers ─────────────────────────────────────────────
  // Trim whitespace, remove BOM characters, collapse internal spaces
  const rawHeaders = Object.keys(rawData[0]);
  const headerMap = {}; // oldHeader → cleanHeader
  const seenHeaders = {};
  rawHeaders.forEach(h => {
    let clean = h
      .replace(/^\uFEFF/, "")          // strip UTF-8 BOM
      .replace(/\r/g, "")              // strip carriage returns
      .trim()                           // leading/trailing whitespace
      .replace(/\s+/g, " ");           // collapse internal spaces
    // Handle duplicate headers by appending _2, _3 etc.
    if (seenHeaders[clean] !== undefined) {
      seenHeaders[clean]++;
      const renamed = `${clean}_${seenHeaders[clean]}`;
      issues.push(`Duplicate column "${clean}" renamed to "${renamed}"`);
      clean = renamed;
    } else {
      seenHeaders[clean] = 1;
    }
    if (clean !== h) issues.push(`Header "${h}" normalized to "${clean}"`);
    headerMap[h] = clean;
  });

  // ── STEP 2: Re-key all rows with clean headers ────────────────────────────
  let rows = rawData.map(row => {
    const clean = {};
    Object.entries(row).forEach(([k, v]) => {
      clean[headerMap[k] ?? k] = v;
    });
    return clean;
  });

  // ── STEP 3: Drop fully-empty rows ────────────────────────────────────────
  const beforeEmpty = rows.length;
  rows = rows.filter(row => Object.values(row).some(v => v !== "" && v !== null && v !== undefined));
  const emptyDropped = beforeEmpty - rows.length;
  if (emptyDropped > 0) issues.push(`Removed ${emptyDropped} fully-empty row${emptyDropped > 1 ? "s" : ""}`);

  // ── STEP 4: Detect and handle duplicate rows ──────────────────────────────
  const seen = new Set();
  const deduped = [];
  let dupCount = 0;
  rows.forEach(row => {
    const key = JSON.stringify(row);
    if (seen.has(key)) { dupCount++; }
    else { seen.add(key); deduped.push(row); }
  });
  if (dupCount > 0) {
    issues.push(`Removed ${dupCount} exact duplicate row${dupCount > 1 ? "s" : ""}`);
    rows = deduped;
  }

  // ── STEP 5: Clean cell values ─────────────────────────────────────────────
  const cleanHeaders = Object.keys(rows[0] || {});
  rows = rows.map((row, rowIdx) => {
    const cleaned = {};
    cleanHeaders.forEach(col => {
      let val = row[col];

      // Normalize to string first
      val = val === null || val === undefined ? "" : String(val);

      // Strip BOM/carriage returns from values too
      val = val.replace(/^\uFEFF/, "").replace(/\r/g, "").trim();

      // Standardize common boolean-like values
      const lower = val.toLowerCase();
      if (lower === "yes" || lower === "y" || lower === "true" || lower === "1" || lower === "present" || lower === "boarded") {
        // keep original — metric engine handles these
      } else if (lower === "no" || lower === "n" || lower === "false" || lower === "0" || lower === "absent" || lower === "missed") {
        // keep original — metric engine handles these
      }

      // Standardize number formatting: remove thousands separators, currency symbols, extra spaces
      // Only do this if the column looks numeric (>50% of non-empty values parse as numbers)
      cleaned[col] = val;
    });
    return cleaned;
  });

  // ── STEP 6: Detect numeric columns and normalize them ────────────────────
  cleanHeaders.forEach(col => {
    const nonEmpty = rows.map(r => r[col]).filter(v => v !== "");
    if (nonEmpty.length === 0) return;

    const numericCount = nonEmpty.filter(v => {
      const stripped = String(v).replace(/[,$€£¥%\s]/g, "").replace(/—/g, "");
      return stripped !== "" && !isNaN(parseFloat(stripped));
    }).length;

    const isNumericCol = numericCount / nonEmpty.length >= 0.6; // 60%+ are numeric

    if (isNumericCol) {
      let fixedCount = 0;
      rows = rows.map(row => {
        const v = row[col];
        if (v === "" || v === "—" || v === "-" || v.toLowerCase() === "n/a" || v.toLowerCase() === "null") {
          // Fill missing numeric values with empty string (metric engine handles || 0)
          return { ...row, [col]: "" };
        }
        // Remove currency/thousands formatting
        const stripped = String(v).replace(/[,$€£¥\s]/g, "");
        if (stripped !== v) { fixedCount++; return { ...row, [col]: stripped }; }
        return row;
      });
      if (fixedCount > 0) issues.push(`Stripped currency/formatting from ${fixedCount} cell${fixedCount > 1 ? "s" : ""} in "${col}"`);
    }
  });

  // ── STEP 7: Standardize Yes/No columns ───────────────────────────────────
  cleanHeaders.forEach(col => {
    const nonEmpty = rows.map(r => r[col]).filter(v => v !== "");
    const boolLike = nonEmpty.filter(v => ["yes","no","y","n","true","false","1","0","present","absent","boarded","missed"].includes(String(v).toLowerCase()));
    if (boolLike.length / (nonEmpty.length || 1) >= 0.7) {
      let fixCount = 0;
      rows = rows.map(row => {
        const lower = String(row[col]).toLowerCase();
        if (["y","true","1","present","boarded"].includes(lower)) { fixCount++; return { ...row, [col]: "Yes" }; }
        if (["n","false","0","absent","missed"].includes(lower)) { fixCount++; return { ...row, [col]: "No" }; }
        return row;
      });
      if (fixCount > 0) issues.push(`Standardized ${fixCount} Yes/No value${fixCount > 1 ? "s" : ""} in "${col}"`);
    }
  });

  // ── STEP 8: Fill missing values in known-important columns ───────────────
  // If >80% of a column is empty after cleaning, flag it
  cleanHeaders.forEach(col => {
    const emptyCount = rows.filter(r => r[col] === "" || r[col] === null || r[col] === undefined).length;
    if (rows.length > 0 && emptyCount / rows.length > 0.8) {
      issues.push(`⚠ Column "${col}" is mostly empty (${emptyCount}/${rows.length} rows blank) — consider removing it`);
    }
  });

  // ── STEP 9: Detect and report suspicious outliers in numeric cols ─────────
  cleanHeaders.forEach(col => {
    const nums = rows.map(r => parseFloat(String(r[col]).replace(/[,%]/g, ""))).filter(v => !isNaN(v) && isFinite(v));
    if (nums.length < 4) return;
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    const sd = Math.sqrt(nums.map(v => (v - mean) ** 2).reduce((a, b) => a + b, 0) / nums.length);
    const outliers = nums.filter(v => Math.abs(v - mean) > 4 * sd);
    if (outliers.length > 0) issues.push(`⚠ "${col}" has ${outliers.length} statistical outlier${outliers.length > 1 ? "s" : ""} (>4σ from mean) — verify these values`);
  });

  return { data: rows, issues };
}

// ─── CREDENTIALS ──────────────────────────────────────────────────────────────
const ACCOUNTS = {
  director: { password: "Director2026", label: "Director / Manager", icon: "◈", desc: "Full cross-department view" },
  teamlead: { password: "Teamlead2026", label: "Team Lead / Group Lead", icon: "◆", desc: "Your team's performance + your own" },
  employee: { password: "Employee2026", label: "Employee", icon: "◉", desc: "Your personal scorecard" },
};

// ─── THEME ────────────────────────────────────────────────────────────────────
const DARK = {
  bg:"#07070f", surface:"#0e0e1a", surfaceHigh:"#141422",
  border:"#1c1c30", accent:"#6366f1", accentSoft:"#6366f114",
  text:"#e6e6f4", textDim:"#686890", textMuted:"#2e2e48",
  success:"#10b981", warn:"#f59e0b", danger:"#ef4444", purple:"#a855f7",
  successSoft:"#10b98114", warnSoft:"#f59e0b14", dangerSoft:"#ef444414", purpleSoft:"#a855f714",
  toggle:"#141422",
};
const LIGHT = {
  bg:"#f4f4fb", surface:"#ffffff", surfaceHigh:"#efeffa",
  border:"#e1e1ef", accent:"#6366f1", accentSoft:"#6366f111",
  text:"#18182c", textDim:"#686890", textMuted:"#b0b0cc",
  success:"#059669", warn:"#d97706", danger:"#dc2626", purple:"#9333ea",
  successSoft:"#05966911", warnSoft:"#d9770611", dangerSoft:"#dc262611", purpleSoft:"#9333ea11",
  toggle:"#eaeaf8",
};

const LOB_COLORS = ["#6366f1","#10b981","#f59e0b","#ef4444","#06b6d4","#a855f7","#f97316","#14b8a6"];
const DEPTS = ["All Departments","Call Operations","Transport & Attendance","Document Processing","Workforce Scheduling","Quality Assurance","Workforce Management","HR","Leadership","Cross-Department"];
const EVENT_TYPES = [
  { id:"decision",     label:"Leadership Decision",  icon:"◈", color:"#6366f1" },
  { id:"intervention", label:"Manager Intervention", icon:"◆", color:"#10b981" },
  { id:"policy",       label:"Policy Change",        icon:"⬡", color:"#f59e0b" },
  { id:"incident",     label:"Operational Incident", icon:"⚡", color:"#ef4444" },
  { id:"initiative",   label:"New Initiative",       icon:"◉", color:"#a855f7" },
  { id:"outcome",      label:"Observed Outcome",     icon:"✓", color:"#06b6d4" },
];
const OUTCOME_CFG = {
  improved: { label:"Improved",  color:"#10b981", icon:"↑", soft:"#10b98118" },
  worsened: { label:"Worsened",  color:"#ef4444", icon:"↓", soft:"#ef444418" },
  neutral:  { label:"No Change", color:"#6b6b9a", icon:"→", soft:"#6b6b9a18" },
  mixed:    { label:"Mixed",     color:"#f59e0b", icon:"~", soft:"#f59e0b18" },
  pending:  { label:"Pending",   color:"#6366f1", icon:"◌", soft:"#6366f118" },
};
const METRIC_KEYS = [
  { key:"csat",             label:"Customer Satisfaction Score", unit:"/5"  },
  { key:"drop_rate",        label:"Call Drop Rate",              unit:"%"   },
  { key:"aht_min",          label:"Avg Handle Time",             unit:"min" },
  { key:"fcr_pct",          label:"First Contact Resolution",    unit:"%"   },
  { key:"no_show_rate",     label:"No-Show Rate",                unit:"%"   },
  { key:"rejection_pct",    label:"Document Rejection Rate",     unit:"%"   },
  { key:"process_min",      label:"Avg Processing Time",         unit:"min" },
  { key:"adherence_pct",    label:"Schedule Adherence",          unit:"%"   },
  { key:"late_logins",      label:"Late Logins",                 unit:""    },
  { key:"incentive_eligible",label:"Incentive Eligible",         unit:"%"   },
];

const SEED_EVENTS = [
  { id:"evt_001", date:"2024-11-12", type:"intervention", dept:"Call Operations", title:"QA Coaching — Revised Call Script for Low-CSAT Agents", description:"Team manager initiated bi-weekly QA coaching sessions for bottom 3 CSAT performers. A revised call script was introduced emphasising empathy acknowledgement before troubleshooting.", author:"Team Manager", role:"teamlead", metrics_before:{ csat:"3.6", aht_min:"6.2", drop_rate:"8.1", fcr_pct:"74" }, metrics_after:{ csat:"4.1", aht_min:"6.0", drop_rate:"6.8", fcr_pct:"83" }, outcome:"improved", outcome_note:"Customer satisfaction improved 13.9% within 3 weeks. First-contact resolution jumped 9 points.", tags:["coaching","csat","script"], linked_event:"" },
  { id:"evt_002", date:"2024-11-28", type:"policy", dept:"Transport & Attendance", title:"Attendance Policy — 2-Strike Incentive Exclusion Formalised", description:"Following Q3 data showing 18% monthly no-show rate with no formal consequence, leadership formalised the 2-strike rule.", author:"Director", role:"director", metrics_before:{ no_show_rate:"18.2", incentive_eligible:"94" }, metrics_after:{ no_show_rate:"9.4", incentive_eligible:"87" }, outcome:"improved", outcome_note:"No-show rate dropped 48% in the following month.", tags:["policy","attendance","incentive"], linked_event:"" },
  { id:"evt_003", date:"2024-12-05", type:"initiative", dept:"Document Processing", title:"Rejection Rate Task Force — Document UX Field Fix", description:"A cross-functional task force identified that 62% of rejections were caused by a missing mandatory field in the processing portal — a system UX issue, not agent error.", author:"QA Lead", role:"teamlead", metrics_before:{ rejection_pct:"11.4", process_min:"5.6" }, metrics_after:{ rejection_pct:"6.2", process_min:"4.8" }, outcome:"improved", outcome_note:"IT deployed mandatory field validation within one week. Rejection rate dropped 46%.", tags:["rejection","ux","system","documents"], linked_event:"" },
  { id:"evt_004", date:"2024-12-18", type:"incident", dept:"Workforce Scheduling", title:"System Outage — Scheduling Platform Login Failures at Shift Start", description:"The scheduling system experienced intermittent login failures from 07:00–09:30. 14 agents were unable to clock in on time.", author:"IT Operations", role:"teamlead", metrics_before:{ adherence_pct:"94", late_logins:"2" }, metrics_after:{ adherence_pct:"71", late_logins:"14" }, outcome:"worsened", outcome_note:"Adherence dropped to 71% that day. IT has since added a redundant login node.", tags:["incident","system","outage","scheduling"], linked_event:"" },
  { id:"evt_005", date:"2025-01-06", type:"decision", dept:"Leadership", title:"Hiring Freeze Lifted — 4 Additional Call Agents Approved", description:"Following Q4 data showing persistent call drop rates above 7%, the Director approved 4 additional headcount for the call operations team.", author:"Director", role:"director", metrics_before:{ drop_rate:"7.4", aht_min:"6.1" }, metrics_after:{}, outcome:"pending", outcome_note:"Outcome pending. New agents expected to complete onboarding by February 3.", tags:["hiring","headcount","call-ops"], linked_event:"" },
];

// ─── SAMPLES ──────────────────────────────────────────────────────────────────
const SAMPLES = {
  "Call_Operations.csv": `Agent,Date,Calls Answered,Calls Dropped,Avg Handle Time (sec),Answer Speed (sec),Customer Satisfaction,First Contact Resolution %
Ravi Kumar,2024-01-15,42,2,310,18,4.2,87
Priya Sharma,2024-01-15,38,5,340,24,3.8,79
Arjun Nair,2024-01-15,51,1,290,15,4.7,93
Sneha Patel,2024-01-15,35,6,380,28,3.5,72
Vikram Rao,2024-01-15,47,3,305,17,4.4,89
Deepa Menon,2024-01-15,33,7,395,31,3.2,68
Ravi Kumar,2024-01-16,44,1,298,16,4.5,91
Priya Sharma,2024-01-16,40,4,325,22,3.9,81
Arjun Nair,2024-01-16,53,0,280,14,4.8,95
Sneha Patel,2024-01-16,37,5,365,26,3.6,74
Vikram Rao,2024-01-16,49,2,298,16,4.5,91
Deepa Menon,2024-01-16,31,8,410,35,3.1,65`,
  "Transport_Attendance.csv": `Employee,Date,Transport Assigned,Boarded,No Show,Arrival Time,Route,Shift,Monthly No Shows
Ravi Kumar,2024-01-15,Yes,Yes,No,06:42,North Route,Morning,0
Priya Sharma,2024-01-15,Yes,No,Yes,—,South Route,Morning,1
Arjun Nair,2024-01-15,Yes,Yes,No,06:38,East Route,Morning,0
Sneha Patel,2024-01-15,Yes,Yes,No,06:55,West Route,Morning,0
Vikram Rao,2024-01-15,Yes,No,Yes,—,North Route,Morning,2
Deepa Menon,2024-01-15,Yes,Yes,No,07:01,South Route,Morning,1
Ravi Kumar,2024-01-16,Yes,Yes,No,06:40,North Route,Morning,0
Priya Sharma,2024-01-16,Yes,Yes,No,06:51,South Route,Morning,1
Arjun Nair,2024-01-16,Yes,Yes,No,06:37,East Route,Morning,0
Sneha Patel,2024-01-16,Yes,Yes,No,06:53,West Route,Morning,0
Vikram Rao,2024-01-16,Yes,No,Yes,—,North Route,Morning,3
Deepa Menon,2024-01-16,Yes,Yes,No,06:59,South Route,Morning,1`,
  "Document_Processing.csv": `Agent,Date,Docs Assigned,Docs Processed,Docs Rejected,Approval Rate %,Process Time (min),Rejection Rate %
Ravi Kumar,2024-01-15,28,26,2,92.8,4.2,7.2
Priya Sharma,2024-01-15,24,21,3,87.5,5.1,12.5
Arjun Nair,2024-01-15,32,31,1,96.8,3.8,3.2
Sneha Patel,2024-01-15,22,19,3,86.3,5.6,13.7
Vikram Rao,2024-01-15,30,28,2,93.3,4.0,6.7
Deepa Menon,2024-01-15,20,17,3,85.0,6.1,15.0
Ravi Kumar,2024-01-16,29,28,1,96.5,4.0,3.5
Priya Sharma,2024-01-16,25,23,2,92.0,4.8,8.0
Arjun Nair,2024-01-16,33,33,0,100.0,3.5,0.0
Sneha Patel,2024-01-16,23,20,3,86.9,5.4,13.1
Vikram Rao,2024-01-16,31,29,2,93.5,3.9,6.5
Deepa Menon,2024-01-16,19,16,3,84.2,6.3,15.8`,
  "Workforce_Scheduling.csv": `Agent,Date,Shift Start,Shift End,Adherence %,Late Login,Break Violations,Overtime (min)
Ravi Kumar,2024-01-15,07:00,16:00,97,No,0,0
Priya Sharma,2024-01-15,07:00,16:00,84,Yes,1,0
Arjun Nair,2024-01-15,07:00,16:00,99,No,0,15
Sneha Patel,2024-01-15,07:00,16:00,78,Yes,2,0
Vikram Rao,2024-01-15,07:00,16:00,95,No,0,0
Deepa Menon,2024-01-15,07:00,16:00,71,Yes,3,0
Ravi Kumar,2024-01-16,07:00,16:00,98,No,0,10
Priya Sharma,2024-01-16,07:00,16:00,88,No,1,0
Arjun Nair,2024-01-16,07:00,16:00,100,No,0,20
Sneha Patel,2024-01-16,07:00,16:00,80,Yes,1,0
Vikram Rao,2024-01-16,07:00,16:00,96,No,0,5
Deepa Menon,2024-01-16,07:00,16:00,73,Yes,2,0`,
};

// ─── METRIC ENGINE ────────────────────────────────────────────────────────────
function computeMetrics(data, lobName, mapping, lobType) {
  // If we have an AI-detected mapping, use the mapped engine
  if (mapping && lobType && lobType !== "unknown") {
    return computeMetricsWithMapping(data, mapping, lobType);
  }
  if (!data || data.length === 0) return {};
  const nv = v => parseFloat(String(v).replace(/[,$%—\-]/g,"")) || 0;
  const cols = Object.keys(data[0]);
  const m = {};
  cols.forEach(col => {
    const vals = data.map(r => nv(r[col])).filter(v => !isNaN(v) && v > 0);
    if (vals.length > 0) {
      m[col+"_total"] = vals.reduce((a,b)=>a+b,0);
      m[col+"_avg"]   = vals.reduce((a,b)=>a+b,0)/vals.length;
      m[col+"_max"]   = Math.max(...vals);
      m[col+"_min"]   = Math.min(...vals);
    }
  });
  const agentKey = cols.find(c=>["agent","employee","name"].includes(c.toLowerCase()))||cols[0];
  const byAgent = fn => {
    const map = {};
    data.forEach(r=>{ const a=r[agentKey]||"Unknown"; if(!map[a])map[a]=[]; map[a].push(r); });
    return Object.entries(map).map(([name,rows])=>({name,...fn(rows)}));
  };
  const hasCallCols = cols.some(c=>c.toLowerCase().includes("calls answered")||c.toLowerCase().includes("calls dropped"));
  if (hasCallCols) {
    const ansCol=cols.find(c=>c.toLowerCase().includes("calls answered"))||"";
    const drpCol=cols.find(c=>c.toLowerCase().includes("calls dropped"))||"";
    const csatCol=cols.find(c=>c.toLowerCase().includes("satisfaction")||c.toLowerCase().includes("csat"))||"";
    const spdCol=cols.find(c=>c.toLowerCase().includes("answer speed")||c.toLowerCase().includes("speed"))||"";
    const ahtCol=cols.find(c=>c.toLowerCase().includes("handle time"))||"";
    const totalAns=m[ansCol+"_total"]||0, totalDrp=m[drpCol+"_total"]||0;
    m._type="call"; m._drop_rate=totalAns>0?((totalDrp/(totalAns+totalDrp))*100).toFixed(1):"0";
    m._aht_min=ahtCol?((m[ahtCol+"_avg"]||0)/60).toFixed(1):null;
    m._csat=csatCol?(m[csatCol+"_avg"]||0).toFixed(2):null;
    m._risk=totalDrp>(totalAns+totalDrp)*0.1?"HIGH":totalDrp>(totalAns+totalDrp)*0.05?"MEDIUM":"LOW";
    m._agents=byAgent(rows=>({
      calls:rows.reduce((a,r)=>a+nv(r[ansCol]),0),
      dropped:rows.reduce((a,r)=>a+nv(r[drpCol]),0),
      csat:csatCol?(rows.reduce((a,r)=>a+nv(r[csatCol]),0)/rows.length).toFixed(1):"—",
      aht:ahtCol?Math.round(rows.reduce((a,r)=>a+nv(r[ahtCol]),0)/rows.length):"—",
    })).sort((a,b)=>parseFloat(b.csat)-parseFloat(a.csat));
  }
  const hasNoShow=cols.some(c=>c.toLowerCase().includes("no show")||c.toLowerCase().includes("noshow"));
  if (hasNoShow) {
    const nsCol=cols.find(c=>c.toLowerCase().includes("no show")||c.toLowerCase().includes("noshow"))||"";
    const monthNsCol=cols.find(c=>c.toLowerCase().includes("monthly")||c.toLowerCase().includes("month no"))||"";
    const noShows=data.filter(r=>String(r[nsCol]).toLowerCase()==="yes").length;
    m._type="transport"; m._no_shows=noShows; m._no_show_rate=(noShows/data.length*100).toFixed(1);
    m._at_risk=monthNsCol?[...new Set(data.filter(r=>nv(r[monthNsCol])>=2).map(r=>r[agentKey]))]:[];
    m._risk=noShows/data.length>0.2?"HIGH":noShows/data.length>0.1?"MEDIUM":"LOW";
  }
  const hasRejection=cols.some(c=>c.toLowerCase().includes("rejection")||c.toLowerCase().includes("rejected"));
  const hasProcessed=cols.some(c=>c.toLowerCase().includes("processed")||c.toLowerCase().includes("docs processed"));
  if (hasRejection&&hasProcessed) {
    const rejCol=cols.find(c=>c.toLowerCase().includes("rejection rate")||(c.toLowerCase().includes("rejection")&&c.toLowerCase().includes("%")))||cols.find(c=>c.toLowerCase().includes("rejection"))||"";
    const procCol=cols.find(c=>c.toLowerCase().includes("process time")||c.toLowerCase().includes("processing time"))||"";
    const docsRejCol=cols.find(c=>c.toLowerCase().includes("docs rejected")||c.toLowerCase().includes("rejected"))||"";
    const docsProcCol=cols.find(c=>c.toLowerCase().includes("docs processed")||c.toLowerCase().includes("processed"))||"";
    const avgRej=m[rejCol+"_avg"]||0;
    m._type="docs"; m._avg_rejection=avgRej.toFixed(1); m._avg_process=procCol?(m[procCol+"_avg"]||0).toFixed(1):"—";
    m._total_processed=docsProcCol?(m[docsProcCol+"_total"]||0):0; m._total_rejected=docsRejCol?(m[docsRejCol+"_total"]||0):0;
    m._risk=avgRej>12?"HIGH":avgRej>7?"MEDIUM":"LOW";
    m._top_rejectors=byAgent(rows=>({
      rate:rejCol?(rows.reduce((a,r)=>a+nv(r[rejCol]),0)/rows.length).toFixed(1):"—",
      time:procCol?(rows.reduce((a,r)=>a+nv(r[procCol]),0)/rows.length).toFixed(1):"—",
    })).sort((a,b)=>parseFloat(b.rate)-parseFloat(a.rate));
  }
  const hasAdherence=cols.some(c=>c.toLowerCase().includes("adherence"));
  if (hasAdherence) {
    const adhCol=cols.find(c=>c.toLowerCase().includes("adherence"))||"";
    const lateCol=cols.find(c=>c.toLowerCase().includes("late login")||c.toLowerCase().includes("late"))||"";
    const bvCol=cols.find(c=>c.toLowerCase().includes("break violation")||c.toLowerCase().includes("break viol"))||"";
    const avgAdh=m[adhCol+"_avg"]||0;
    m._type="scheduling"; m._adherence=avgAdh.toFixed(1);
    m._late_count=lateCol?data.filter(r=>String(r[lateCol]).toLowerCase()==="yes").length:0;
    m._risk=avgAdh<80?"HIGH":avgAdh<90?"MEDIUM":"LOW";
    m._low_adherence=byAgent(rows=>({
      adherence:(rows.reduce((a,r)=>a+nv(r[adhCol]),0)/rows.length).toFixed(1),
      late:lateCol?rows.filter(r=>String(r[lateCol]).toLowerCase()==="yes").length:0,
      bv:bvCol?rows.reduce((a,r)=>a+nv(r[bvCol]),0):0,
    })).sort((a,b)=>parseFloat(a.adherence)-parseFloat(b.adherence));
  }
  return m;
}

// ─── COLUMN MAPPING SCHEMA ────────────────────────────────────────────────────
// Each slot: what logical metric it represents, display label, which LOB types use it
const MAPPING_SLOTS = [
  // Identity
  { slot:"agentCol",       label:"Agent / Employee Name",       lobTypes:["call","transport","docs","scheduling"], required:true  },
  // Call ops
  { slot:"answeredCol",    label:"Calls Answered",               lobTypes:["call"],         required:false },
  { slot:"droppedCol",     label:"Calls Dropped / Abandoned",    lobTypes:["call"],         required:false },
  { slot:"csatCol",        label:"Customer Satisfaction (CSAT)", lobTypes:["call"],         required:false },
  { slot:"ahtCol",         label:"Avg Handle Time",              lobTypes:["call"],         required:false },
  { slot:"fcrCol",         label:"First Contact Resolution %",   lobTypes:["call"],         required:false },
  // Transport
  { slot:"noShowCol",      label:"No-Show Flag (Yes/No)",        lobTypes:["transport"],    required:false },
  { slot:"monthlyNsCol",   label:"Monthly No-Show Count",        lobTypes:["transport"],    required:false },
  { slot:"arrivalCol",     label:"Arrival Time",                 lobTypes:["transport"],    required:false },
  // Docs
  { slot:"rejRateCol",     label:"Rejection Rate %",             lobTypes:["docs"],         required:false },
  { slot:"docsRejCol",     label:"Docs Rejected (count)",        lobTypes:["docs"],         required:false },
  { slot:"docsProcCol",    label:"Docs Processed (count)",       lobTypes:["docs"],         required:false },
  { slot:"procTimeCol",    label:"Processing Time (min)",        lobTypes:["docs"],         required:false },
  // Scheduling
  { slot:"adherenceCol",   label:"Schedule Adherence %",         lobTypes:["scheduling"],   required:false },
  { slot:"lateCol",        label:"Late Login Flag (Yes/No)",     lobTypes:["scheduling"],   required:false },
  { slot:"breakViolCol",   label:"Break Violations (count)",     lobTypes:["scheduling"],   required:false },
  { slot:"overtimeCol",    label:"Overtime (min)",               lobTypes:["scheduling"],   required:false },
];

// AI-powered column mapping: sends headers + sample rows to Claude, gets back a JSON mapping
async function detectColumnMapping(csvText, fileName) {
  const lines = csvText.split("\n").filter(Boolean);
  const headers = lines[0];
  const sampleRows = lines.slice(1, 5).join("\n"); // up to 4 sample rows

  const system = `You are a data schema analyst. Given CSV column headers and sample data from an operational workforce CSV, identify:
1. The LOB type: one of "call", "transport", "docs", "scheduling", or "unknown"
2. Map each column header to one of these logical slot names (or null if no match):
   agentCol, answeredCol, droppedCol, csatCol, ahtCol, fcrCol,
   noShowCol, monthlyNsCol, arrivalCol,
   rejRateCol, docsRejCol, docsProcCol, procTimeCol,
   adherenceCol, lateCol, breakViolCol, overtimeCol

Rules:
- agentCol: person name/ID column (agent, employee, staff, name, rep, worker)
- answeredCol: total calls handled/answered/taken
- droppedCol: calls dropped/abandoned/missed/lost
- csatCol: customer satisfaction score/rating (numeric 1-5 or 1-10)
- ahtCol: average/mean handle/talk/call duration (seconds or minutes)
- fcrCol: first contact/call resolution percentage
- noShowCol: binary absent/no-show/missed transport (Yes/No or 1/0)
- monthlyNsCol: cumulative monthly absence/no-show count
- rejRateCol: document/case rejection rate as percentage
- docsRejCol: count of rejected documents/cases
- docsProcCol: count of processed/completed documents/cases
- procTimeCol: time to process each document (minutes)
- adherenceCol: schedule adherence percentage
- lateCol: binary late login/late arrival flag (Yes/No or 1/0)
- breakViolCol: break rule violations count
- overtimeCol: overtime minutes worked

Respond ONLY with valid JSON, no markdown, no explanation:
{"lobType":"call","mapping":{"agentCol":"Agent Name","answeredCol":"Total Calls","droppedCol":null,...}}
Include ALL slot keys in mapping, set to null if no match found.`;

  const userMsg = `File: ${fileName}\nHeaders: ${headers}\nSample data:\n${sampleRows}`;

  const res = await fetch("/api/claude", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:600, system, messages:[{role:"user",content:userMsg}] })
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message||"Mapping API error");
  const raw = json.content?.map(b=>b.text||"").join("").trim();
  // strip any accidental markdown fences
  const clean = raw.replace(/```json|```/g,"").trim();
  return JSON.parse(clean);
}

// computeMetrics variant that uses an explicit column mapping instead of heuristics
function computeMetricsWithMapping(data, mapping, lobType) {
  if (!data || data.length === 0) return {};
  const nv = v => parseFloat(String(v).replace(/[,$%—\-]/g,"")) || 0;
  const cols = Object.keys(data[0]);
  const m = {};

  // Always compute generic stats for every numeric column
  cols.forEach(col => {
    const vals = data.map(r => nv(r[col])).filter(v => !isNaN(v) && v > 0);
    if (vals.length > 0) {
      m[col+"_total"] = vals.reduce((a,b)=>a+b,0);
      m[col+"_avg"]   = vals.reduce((a,b)=>a+b,0)/vals.length;
      m[col+"_max"]   = Math.max(...vals);
      m[col+"_min"]   = Math.min(...vals);
    }
  });

  const mp = mapping; // shorthand
  const agentKey = mp.agentCol || cols.find(c=>["agent","employee","name"].includes(c.toLowerCase())) || cols[0];

  const byAgent = fn => {
    const map = {};
    data.forEach(r=>{ const a=r[agentKey]||"Unknown"; if(!map[a])map[a]=[]; map[a].push(r); });
    return Object.entries(map).map(([name,rows])=>({name,...fn(rows)}));
  };

  if (lobType === "call") {
    const ansCol = mp.answeredCol||"", drpCol = mp.droppedCol||"";
    const csatCol = mp.csatCol||"", ahtCol = mp.ahtCol||"", fcrCol = mp.fcrCol||"";
    const totalAns = ansCol?(m[ansCol+"_total"]||0):0;
    const totalDrp = drpCol?(m[drpCol+"_total"]||0):0;
    m._type="call";
    m._drop_rate = totalAns>0?((totalDrp/(totalAns+totalDrp))*100).toFixed(1):"0";
    m._aht_min = ahtCol?((m[ahtCol+"_avg"]||0)/60).toFixed(1):null;
    m._csat = csatCol?(m[csatCol+"_avg"]||0).toFixed(2):null;
    m._fcr = fcrCol?(m[fcrCol+"_avg"]||0).toFixed(1):null;
    m._risk = totalDrp>(totalAns+totalDrp)*0.1?"HIGH":totalDrp>(totalAns+totalDrp)*0.05?"MEDIUM":"LOW";
    m._agents = byAgent(rows=>({
      calls:  ansCol?rows.reduce((a,r)=>a+nv(r[ansCol]),0):0,
      dropped:drpCol?rows.reduce((a,r)=>a+nv(r[drpCol]),0):0,
      csat:   csatCol?(rows.reduce((a,r)=>a+nv(r[csatCol]),0)/rows.length).toFixed(1):"—",
      aht:    ahtCol?Math.round(rows.reduce((a,r)=>a+nv(r[ahtCol]),0)/rows.length):"—",
    })).sort((a,b)=>parseFloat(b.csat||0)-parseFloat(a.csat||0));
  }

  if (lobType === "transport") {
    const nsCol = mp.noShowCol||"", monthNsCol = mp.monthlyNsCol||"";
    const noShows = nsCol?data.filter(r=>["yes","1","true","absent"].includes(String(r[nsCol]).toLowerCase())).length:0;
    m._type="transport";
    m._no_shows = noShows;
    m._no_show_rate = (noShows/data.length*100).toFixed(1);
    m._at_risk = monthNsCol?[...new Set(data.filter(r=>nv(r[monthNsCol])>=2).map(r=>r[agentKey]))]:[];
    m._risk = noShows/data.length>0.2?"HIGH":noShows/data.length>0.1?"MEDIUM":"LOW";
    m._transport_agents = byAgent(rows=>({
      noShows: nsCol?rows.filter(r=>["yes","1","true","absent"].includes(String(r[nsCol]).toLowerCase())).length:0,
      monthlyNs: monthNsCol?Math.max(...rows.map(r=>nv(r[monthNsCol]))):0,
    })).sort((a,b)=>b.noShows-a.noShows);
  }

  if (lobType === "docs") {
    const rejCol = mp.rejRateCol||"", procCol = mp.procTimeCol||"";
    const docsRejCol = mp.docsRejCol||"", docsProcCol = mp.docsProcCol||"";
    const avgRej = rejCol?(m[rejCol+"_avg"]||0):0;
    m._type="docs";
    m._avg_rejection = avgRej.toFixed(1);
    m._avg_process = procCol?(m[procCol+"_avg"]||0).toFixed(1):"—";
    m._total_processed = docsProcCol?(m[docsProcCol+"_total"]||0):0;
    m._total_rejected = docsRejCol?(m[docsRejCol+"_total"]||0):0;
    m._risk = avgRej>12?"HIGH":avgRej>7?"MEDIUM":"LOW";
    m._top_rejectors = byAgent(rows=>({
      rate: rejCol?(rows.reduce((a,r)=>a+nv(r[rejCol]),0)/rows.length).toFixed(1):"—",
      time: procCol?(rows.reduce((a,r)=>a+nv(r[procCol]),0)/rows.length).toFixed(1):"—",
      rejected: docsRejCol?rows.reduce((a,r)=>a+nv(r[docsRejCol]),0):0,
    })).sort((a,b)=>parseFloat(b.rate||0)-parseFloat(a.rate||0));
  }

  if (lobType === "scheduling") {
    const adhCol = mp.adherenceCol||"", lateCol = mp.lateCol||"", bvCol = mp.breakViolCol||"";
    const avgAdh = adhCol?(m[adhCol+"_avg"]||0):0;
    m._type="scheduling";
    m._adherence = avgAdh.toFixed(1);
    m._late_count = lateCol?data.filter(r=>["yes","1","true"].includes(String(r[lateCol]).toLowerCase())).length:0;
    m._risk = avgAdh<80?"HIGH":avgAdh<90?"MEDIUM":"LOW";
    m._low_adherence = byAgent(rows=>({
      adherence: adhCol?(rows.reduce((a,r)=>a+nv(r[adhCol]),0)/rows.length).toFixed(1):"—",
      late: lateCol?rows.filter(r=>["yes","1","true"].includes(String(r[lateCol]).toLowerCase())).length:0,
      bv: bvCol?rows.reduce((a,r)=>a+nv(r[bvCol]),0):0,
    })).sort((a,b)=>parseFloat(a.adherence||100)-parseFloat(b.adherence||100));
  }

  return m;
}

// ─── EARLY WARNING ENGINE ─────────────────────────────────────────────────────
function runEWE(lobs) {
  const alerts=[]; const ts=new Date().toLocaleTimeString();
  lobs.forEach(lob=>{
    const m=computeMetrics(lob.data,lob.name,lob.mapping,lob.lobType);
    if(m._type==="call"){
      const dr=parseFloat(m._drop_rate||0);
      if(dr>10) alerts.push({id:`${lob.name}-drop-crit`,severity:"CRITICAL",dept:lob.name,type:"CALL QUALITY",title:`Drop rate at ${m._drop_rate}% — above SLA threshold`,evidence:`${lob.name} drop rate: ${m._drop_rate}%. Target: <7%.`,impact:"Customer satisfaction and SLA breach risk.",intervention:"Review staffing levels and call routing. Check for system issues.",confidence:92,detectedAt:ts,source:"Call Operations Monitor"});
      else if(dr>5) alerts.push({id:`${lob.name}-drop-warn`,severity:"WARNING",dept:lob.name,type:"CALL QUALITY",title:`Drop rate trending up — ${m._drop_rate}%`,evidence:`${lob.name} drop rate: ${m._drop_rate}%. Approaching 7% SLA limit.`,impact:"Early warning — act before SLA breach.",intervention:"Monitor closely. Check agent availability.",confidence:79,detectedAt:ts,source:"Call Operations Monitor"});
      if(m._csat&&parseFloat(m._csat)<3.8) alerts.push({id:`${lob.name}-csat`,severity:"CRITICAL",dept:lob.name,type:"CSAT",title:`CSAT at ${m._csat} — below minimum threshold`,evidence:`Average CSAT: ${m._csat}/5. Minimum acceptable: 3.8.`,impact:"Customer churn risk. Potential escalation to client.",intervention:"Identify lowest-scoring agents and initiate coaching.",confidence:88,detectedAt:ts,source:"Quality Monitor"});
    }
    if(m._type==="transport"){
      const ns=parseFloat(m._no_show_rate||0);
      if(ns>15) alerts.push({id:`${lob.name}-noshow-crit`,severity:"CRITICAL",dept:lob.name,type:"ATTENDANCE",title:`No-show rate at ${m._no_show_rate}% — floor coverage at risk`,evidence:`${m._no_shows} no-shows out of ${lob.data.length} records.`,impact:"Floor coverage gap. Increased load on present agents.",intervention:"Enforce attendance policy. Flag repeat offenders.",confidence:95,detectedAt:ts,source:"Attendance Monitor"});
      else if(ns>8) alerts.push({id:`${lob.name}-noshow-warn`,severity:"WARNING",dept:lob.name,type:"ATTENDANCE",title:`No-show rate rising — ${m._no_show_rate}%`,evidence:`No-show rate: ${m._no_show_rate}%. Threshold: 10%.`,impact:"Attendance pressure building.",intervention:"Review transport logistics. Check for route issues.",confidence:81,detectedAt:ts,source:"Attendance Monitor"});
    }
    if(m._type==="docs"){
      const rj=parseFloat(m._avg_rejection||0);
      if(rj>12) alerts.push({id:`${lob.name}-rej-crit`,severity:"CRITICAL",dept:lob.name,type:"DOCUMENT QUALITY",title:`Rejection rate at ${m._avg_rejection}% — quality breakdown`,evidence:`Avg rejection rate: ${m._avg_rejection}%. Target: <8%.`,impact:"Rework cost and processing delays.",intervention:"Audit top rejectors. Check if system or training issue.",confidence:87,detectedAt:ts,source:"Document Quality Monitor"});
      else if(rj>7) alerts.push({id:`${lob.name}-rej-warn`,severity:"WARNING",dept:lob.name,type:"DOCUMENT QUALITY",title:`Rejection rate at ${m._avg_rejection}% — trending toward threshold`,evidence:`Avg rejection rate: ${m._avg_rejection}%. Monitor closely.`,impact:"Quality trending downward.",intervention:"Coach agents with rates above team average.",confidence:74,detectedAt:ts,source:"Document Quality Monitor"});
    }
    if(m._type==="scheduling"){
      const adh=parseFloat(m._adherence||0);
      if(adh<80) alerts.push({id:`${lob.name}-adh-crit`,severity:"CRITICAL",dept:lob.name,type:"SCHEDULE ADHERENCE",title:`Adherence at ${m._adherence}% — floor coverage impacted`,evidence:`Avg adherence: ${m._adherence}%. ${m._late_count} late logins.`,impact:"Coverage gap affecting queue lengths.",intervention:"Investigate root cause. Check for system or transport issues.",confidence:90,detectedAt:ts,source:"Scheduling Monitor"});
      else if(adh<90) alerts.push({id:`${lob.name}-adh-warn`,severity:"WARNING",dept:lob.name,type:"SCHEDULE ADHERENCE",title:`Adherence dipping — ${m._adherence}%`,evidence:`Adherence: ${m._adherence}%. ${m._late_count} late logins this period.`,impact:"Schedule pressure building.",intervention:"Remind team leads. Check late login patterns.",confidence:76,detectedAt:ts,source:"Scheduling Monitor"});
    }
  });
  return alerts.sort((a,b)=>({CRITICAL:0,WARNING:1,INFO:2}[a.severity]??3)-({CRITICAL:0,WARNING:1,INFO:2}[b.severity]??3));
}

// ─── AI CALL (uses artifact built-in API proxy) ───────────────────────────────
async function callAI(system, userMsg, maxTokens=600) {
  const res = await fetch("/api/claude", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:maxTokens, system, messages:[{role:"user",content:userMsg}] })
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message||"API error");
  return json.content?.map(b=>b.text||"").join("") || "No response generated.";
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const GS = `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=DM+Serif+Display:ital@0;1&display=swap');*{box-sizing:border-box}@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.6}}@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}`;

// ─── PRIMITIVES ───────────────────────────────────────────────────────────────
const GS2 = (C) => ({
  btn: { background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:7, padding:"6px 13px", fontSize:12, cursor:"pointer", transition:"all 0.15s" },
  inp: { background:C.surfaceHigh, border:`1px solid ${C.border}`, color:C.text, borderRadius:7, padding:"8px 11px", fontSize:13, width:"100%", fontFamily:"inherit", outline:"none" },
  lbl: { color:C.textDim, fontSize:11, textTransform:"uppercase", letterSpacing:"0.07em", fontWeight:600, marginBottom:4, display:"block" },
});

function BackBtn({ onClick, C }) {
  return (
    <button onClick={onClick} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:7, padding:"5px 12px", fontSize:12, cursor:"pointer", display:"flex", alignItems:"center", gap:5, transition:"all 0.15s" }}
      onMouseEnter={e=>{ e.currentTarget.style.borderColor=C.accent; e.currentTarget.style.color=C.accent; }}
      onMouseLeave={e=>{ e.currentTarget.style.borderColor=C.border; e.currentTarget.style.color=C.textDim; }}>
      ← Back
    </button>
  );
}
function Spinner({ C, label="Generating AI insight..." }) {
  return <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 0" }}><div style={{ width:15, height:15, border:`2px solid ${C.border}`, borderTop:`2px solid ${C.accent}`, borderRadius:"50%", animation:"spin 0.7s linear infinite" }}/><span style={{ color:C.textDim, fontSize:13 }}>{label}</span></div>;
}
function RiskBadge({ level, C }) {
  const cfg={ HIGH:[C.dangerSoft,C.danger,"HIGH RISK"], MEDIUM:[C.warnSoft,C.warn,"MED RISK"], LOW:[C.successSoft,C.success,"LOW RISK"] }[level];
  if (!cfg) return null;
  return <span style={{ background:cfg[0], color:cfg[1], border:`1px solid ${cfg[1]}44`, borderRadius:5, padding:"2px 8px", fontSize:10, fontWeight:700 }}>{cfg[2]}</span>;
}
function StatCard({ label, value, sub, color, C }) {
  return <div style={{ background:C.surfaceHigh, border:`1px solid ${C.border}`, borderRadius:10, padding:"12px 14px", flex:"1 1 110px" }}><div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:5 }}>{label}</div><div style={{ color:color||C.text, fontSize:20, fontWeight:700, fontFamily:"monospace" }}>{value}</div>{sub&&<div style={{ color:C.textDim, fontSize:11, marginTop:2 }}>{sub}</div>}</div>;
}
function AIResult({ text, color, label, C }) {
  if (!text) return null;
  return (
    <div style={{ background:C.accentSoft, border:`1px solid ${color}40`, borderRadius:12, padding:"16px 18px", marginBottom:16, animation:"fadeIn 0.3s ease" }}>
      <div style={{ color, fontSize:10, textTransform:"uppercase", letterSpacing:"0.1em", fontWeight:700, marginBottom:10 }}>◈ AI Intelligence · {label}</div>
      {text.split("\n").filter(Boolean).map((line,i)=>{
        const isHeader = line.startsWith("ROOT CAUSE")||line.startsWith("CONTRIBUTING")||line.startsWith("HEADLINE")||line.startsWith("PATTERN")||line.startsWith("WHAT WORKED")||line.startsWith("WHAT DIDN");
        const isAction = line.startsWith("→");
        const isWarn   = line.startsWith("⚠")||line.startsWith("HIGHEST RISK");
        const isBullet = line.startsWith("•");
        return (
          <div key={i} style={{
            color: isWarn?C.warn:isAction?color:isBullet?C.text:isHeader?color:C.text,
            fontSize: isHeader?12:13,
            lineHeight: 1.8,
            marginBottom: isHeader?6:3,
            fontWeight: isHeader||isAction?700:isBullet?500:400,
            paddingLeft: isBullet?10:0,
            marginTop: isHeader&&i>0?10:0,
            textTransform: isHeader?"uppercase":undefined,
            letterSpacing: isHeader?"0.06em":undefined,
          }}>{line}</div>
        );
      })}
      <div style={{ marginTop:10, paddingTop:8, borderTop:`1px solid ${C.border}`, color:C.textDim, fontSize:10 }}>Evidence-based · Clarix Analytics Engine</div>
    </div>
  );
}
function MiniTable({ rows, headers, C }) {
  if (!rows||rows.length===0) return null;
  return <div style={{ overflowX:"auto", border:`1px solid ${C.border}`, borderRadius:9, marginBottom:16 }}><table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}><thead><tr style={{ background:C.surfaceHigh }}>{headers.map(h=><th key={h} style={{ padding:"8px 12px", textAlign:h==="name"?"left":"right", color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.06em", borderBottom:`1px solid ${C.border}`, fontWeight:600, whiteSpace:"nowrap" }}>{h}</th>)}</tr></thead><tbody>{rows.map((row,i)=><tr key={i} style={{ borderBottom:`1px solid ${C.border}22` }}>{headers.map(h=><td key={h} style={{ padding:"8px 12px", color:C.text, textAlign:h==="name"?"left":"right", fontFamily:h!=="name"?"monospace":"inherit", fontSize:12, whiteSpace:"nowrap" }}>{h==="name"&&<span style={{ color:C.textDim, fontFamily:"monospace", marginRight:8 }}>#{i+1}</span>}{row[h]}</td>)}</tr>)}</tbody></table></div>;
}
function RawTable({ data, C }) {
  const [page,setPage]=useState(0);
  if (!data||data.length===0) return null;
  const headers=Object.keys(data[0]),ps=8,pages=Math.ceil(data.length/ps);
  return <div><div style={{ overflowX:"auto", border:`1px solid ${C.border}`, borderRadius:9 }}><table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}><thead><tr style={{ background:C.surfaceHigh }}>{headers.map(h=><th key={h} style={{ padding:"8px 12px", textAlign:"left", color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.06em", borderBottom:`1px solid ${C.border}`, fontWeight:600, whiteSpace:"nowrap" }}>{h}</th>)}</tr></thead><tbody>{data.slice(page*ps,(page+1)*ps).map((row,i)=><tr key={i} style={{ borderBottom:`1px solid ${C.border}22` }}>{headers.map(h=><td key={h} style={{ padding:"8px 12px", color:C.text, fontFamily:"monospace", fontSize:12, whiteSpace:"nowrap" }}>{row[h]}</td>)}</tr>)}</tbody></table></div>{pages>1&&<div style={{ display:"flex", gap:5, marginTop:8, justifyContent:"flex-end" }}>{Array.from({length:pages},(_,i)=><button key={i} onClick={()=>setPage(i)} style={{ width:26,height:26,borderRadius:5,background:page===i?C.accent:C.surfaceHigh,border:`1px solid ${page===i?C.accent:C.border}`,color:page===i?"#fff":C.textDim,fontSize:11,cursor:"pointer" }}>{i+1}</button>)}</div>}</div>;
}
function MetricDelta({ before, after, C }) {
  if(!before||Object.keys(before).length===0) return null;
  const higherIsBetter=["csat","fcr_pct","adherence_pct","incentive_eligible"];
  return (
    <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginTop:10 }}>
      {Object.keys(before).map(k=>{
        const mk=METRIC_KEYS.find(m=>m.key===k);
        const label=mk?mk.label:k, unit=mk?mk.unit:"";
        const bv=parseFloat(before[k]);
        const av=after&&after[k]!=null&&after[k]!==""?parseFloat(after[k]):null;
        const delta=av!==null?av-bv:null;
        const pct=bv!==0&&delta!==null?((delta/Math.abs(bv))*100).toFixed(1):null;
        const good=delta!==null&&(higherIsBetter.includes(k)?delta>0:delta<0);
        return (
          <div key={k} style={{ background:C.surfaceHigh, border:`1px solid ${C.border}`, borderRadius:8, padding:"8px 12px", minWidth:100 }}>
            <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>{label}</div>
            <div style={{ display:"flex", alignItems:"baseline", gap:6, flexWrap:"wrap" }}>
              <span style={{ color:C.textDim, fontFamily:"monospace", fontSize:12, textDecoration:"line-through" }}>{before[k]}{unit}</span>
              {av!==null&&<><span style={{ color:C.textDim, fontSize:10 }}>→</span><span style={{ color:good?C.success:delta!==null&&delta!==0?C.danger:C.textDim, fontFamily:"monospace", fontSize:13, fontWeight:700 }}>{after[k]}{unit}</span>{pct&&<span style={{ color:good?C.success:C.danger, fontSize:10, fontWeight:600 }}>{good?"+":""}{pct}%</span>}</>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── EMPLOYEE SCORECARD ───────────────────────────────────────────────────────
const EMP_PROFILE = {
  name:"Aryan Mehta", id:"EMP-2047", dept:"Document Processing",
  team:"Batch Processing Unit — Team B", joinDate:"March 2023", avatar:"AM",
};
// PKT is a monthly-only assessment — done once per month, never tracked daily or weekly
const EMP_METRICS_DAILY = {
  quality_score:    { label:"Quality Score",      unit:"%",   target:92,  hi:true  },
  account_logs:     { label:"Account Logs",        unit:"",    target:30,  hi:true  },
  document_logs:    { label:"Document Logs",       unit:"",    target:62,  hi:true  },
  processing_time:  { label:"Avg Processing Time", unit:"min", target:4.2, hi:false },
  login_hours:      { label:"Login Hours",         unit:"hrs", target:8.0, hi:true  },
  planned_leaves:   { label:"Planned Leaves",      unit:"",    target:0,   hi:false },
  unplanned_leaves: { label:"Unplanned Leaves",    unit:"",    target:0,   hi:false },
};
const EMP_METRICS_WEEKLY = {
  quality_score:    { label:"Quality Score",      unit:"%",   target:92,  hi:true  },
  account_logs:     { label:"Account Logs",        unit:"",    target:148, hi:true  },
  document_logs:    { label:"Document Logs",       unit:"",    target:305, hi:true  },
  processing_time:  { label:"Avg Processing Time", unit:"min", target:4.2, hi:false },
  login_hours:      { label:"Login Hours",         unit:"hrs", target:40.0,hi:true  },
  planned_leaves:   { label:"Planned Leaves",      unit:"",    target:1,   hi:false },
  unplanned_leaves: { label:"Unplanned Leaves",    unit:"",    target:0,   hi:false },
};
// Monthly overview uses PKT — it's assessed once per month only
const EMP_METRICS_META = {
  quality_score:    { label:"Quality Score",      unit:"%",   target:92,  hi:true  },
  account_logs:     { label:"Account Logs",        unit:"",    target:620, hi:true  },
  document_logs:    { label:"Document Logs",       unit:"",    target:1250,hi:true  },
  processing_time:  { label:"Avg Processing Time", unit:"min", target:4.2, hi:false },
  pkt_score:        { label:"PKT Score (Monthly)", unit:"%",   target:80,  hi:true  },
  login_hours:      { label:"Login Hours",         unit:"hrs", target:160, hi:true  },
  planned_leaves:   { label:"Planned Leaves",      unit:"",    target:2,   hi:false },
  unplanned_leaves: { label:"Unplanned Leaves",    unit:"",    target:1,   hi:false },
};
// Daily: no PKT (monthly-only test), realistic mid-performer numbers
const EMP_DAILY = [
  { day:"Mon", quality_score:85, account_logs:27, document_logs:54, processing_time:4.7, login_hours:7.7, planned_leaves:0, unplanned_leaves:0 },
  { day:"Tue", quality_score:88, account_logs:30, document_logs:61, processing_time:4.4, login_hours:7.9, planned_leaves:0, unplanned_leaves:0 },
  { day:"Wed", quality_score:82, account_logs:24, document_logs:49, processing_time:5.0, login_hours:7.2, planned_leaves:0, unplanned_leaves:1 },
  { day:"Thu", quality_score:90, account_logs:32, document_logs:65, processing_time:4.2, login_hours:8.1, planned_leaves:0, unplanned_leaves:0 },
  { day:"Fri", quality_score:86, account_logs:28, document_logs:58, processing_time:4.5, login_hours:7.8, planned_leaves:0, unplanned_leaves:0 },
];
// Weekly: no PKT column (PKT is monthly only)
const EMP_WEEKLY = [
  { week:"W18", quality_score:84, account_logs:131, document_logs:263, processing_time:4.8, login_hours:36.8, planned_leaves:0, unplanned_leaves:2 },
  { week:"W19", quality_score:86, account_logs:138, document_logs:278, processing_time:4.6, login_hours:37.9, planned_leaves:1, unplanned_leaves:1 },
  { week:"W20", quality_score:85, account_logs:134, document_logs:270, processing_time:4.7, login_hours:37.4, planned_leaves:0, unplanned_leaves:2 },
  { week:"W21 (Current)", quality_score:86, account_logs:141, document_logs:287, processing_time:4.5, login_hours:38.7, planned_leaves:0, unplanned_leaves:1 },
];
// Monthly: PKT appears here only — assessed once per month
const EMP_MONTHLY = [
  { month:"Feb", quality_score:83, account_logs:531, document_logs:1063, processing_time:4.9, pkt_score:68, login_hours:148, planned_leaves:1, unplanned_leaves:5 },
  { month:"Mar", quality_score:85, account_logs:558, document_logs:1117, processing_time:4.7, pkt_score:72, login_hours:152, planned_leaves:2, unplanned_leaves:4 },
  { month:"Apr", quality_score:87, account_logs:581, document_logs:1162, processing_time:4.5, pkt_score:75, login_hours:156, planned_leaves:1, unplanned_leaves:3 },
  { month:"May (MTD)", quality_score:86, account_logs:594, document_logs:1187, processing_time:4.6, pkt_score:73, login_hours:154, planned_leaves:0, unplanned_leaves:2 },
];

// ─── TEAM MEMBERS DATA (used by Team Lead & Director Performance Dashboard) ────
// Each member has monthly snapshot data mirroring Aryan's scorecard structure.
// PKT is monthly-only — appears in monthly snapshot, not daily/weekly.
const TEAM_MEMBERS = [
  {
    profile: { name:"Aryan Mehta", id:"EMP-2047", dept:"Document Processing", team:"Batch Processing Unit — Team B", joinDate:"March 2023", avatar:"AM" },
    tier: "mid",
    monthly: { quality_score:86, account_logs:594, document_logs:1187, processing_time:4.6, pkt_score:73, login_hours:154, planned_leaves:0, unplanned_leaves:2 },
    weekly:  [
      { week:"W18", quality_score:84, account_logs:131, document_logs:263, processing_time:4.8, login_hours:36.8, planned_leaves:0, unplanned_leaves:2 },
      { week:"W19", quality_score:86, account_logs:138, document_logs:278, processing_time:4.6, login_hours:37.9, planned_leaves:1, unplanned_leaves:1 },
      { week:"W20", quality_score:85, account_logs:134, document_logs:270, processing_time:4.7, login_hours:37.4, planned_leaves:0, unplanned_leaves:2 },
      { week:"W21", quality_score:86, account_logs:141, document_logs:287, processing_time:4.5, login_hours:38.7, planned_leaves:0, unplanned_leaves:1 },
    ],
  },
  {
    profile: { name:"Priya Sharma", id:"EMP-2031", dept:"Call Operations", team:"Inbound Voice — Team A", joinDate:"January 2022", avatar:"PS" },
    tier: "high",
    monthly: { quality_score:94, account_logs:672, document_logs:1344, processing_time:3.8, pkt_score:88, login_hours:163, planned_leaves:1, unplanned_leaves:0 },
    weekly:  [
      { week:"W18", quality_score:93, account_logs:162, document_logs:324, processing_time:3.9, login_hours:40.2, planned_leaves:0, unplanned_leaves:0 },
      { week:"W19", quality_score:95, account_logs:168, document_logs:336, processing_time:3.7, login_hours:40.8, planned_leaves:1, unplanned_leaves:0 },
      { week:"W20", quality_score:94, account_logs:165, document_logs:330, processing_time:3.8, login_hours:40.5, planned_leaves:0, unplanned_leaves:0 },
      { week:"W21", quality_score:95, account_logs:170, document_logs:341, processing_time:3.7, login_hours:41.0, planned_leaves:0, unplanned_leaves:0 },
    ],
  },
  {
    profile: { name:"Ravi Kumar", id:"EMP-2018", dept:"Document Processing", team:"Batch Processing Unit — Team A", joinDate:"June 2021", avatar:"RK" },
    tier: "mid",
    monthly: { quality_score:88, account_logs:607, document_logs:1214, processing_time:4.3, pkt_score:76, login_hours:158, planned_leaves:2, unplanned_leaves:1 },
    weekly:  [
      { week:"W18", quality_score:87, account_logs:146, document_logs:292, processing_time:4.4, login_hours:38.5, planned_leaves:0, unplanned_leaves:1 },
      { week:"W19", quality_score:89, account_logs:151, document_logs:302, processing_time:4.2, login_hours:39.1, planned_leaves:1, unplanned_leaves:0 },
      { week:"W20", quality_score:88, account_logs:149, document_logs:298, processing_time:4.3, login_hours:38.9, planned_leaves:0, unplanned_leaves:0 },
      { week:"W21", quality_score:89, account_logs:153, document_logs:306, processing_time:4.1, login_hours:39.4, planned_leaves:0, unplanned_leaves:0 },
    ],
  },
  {
    profile: { name:"Sneha Patel", id:"EMP-2055", dept:"Workforce Scheduling", team:"Scheduling Operations — Team C", joinDate:"September 2023", avatar:"SP" },
    tier: "low",
    monthly: { quality_score:79, account_logs:502, document_logs:1004, processing_time:5.4, pkt_score:61, login_hours:144, planned_leaves:2, unplanned_leaves:5 },
    weekly:  [
      { week:"W18", quality_score:77, account_logs:118, document_logs:237, processing_time:5.6, login_hours:34.2, planned_leaves:0, unplanned_leaves:2 },
      { week:"W19", quality_score:80, account_logs:124, document_logs:248, processing_time:5.3, login_hours:35.4, planned_leaves:1, unplanned_leaves:1 },
      { week:"W20", quality_score:78, account_logs:120, document_logs:240, processing_time:5.5, login_hours:34.8, planned_leaves:0, unplanned_leaves:1 },
      { week:"W21", quality_score:79, account_logs:122, document_logs:244, processing_time:5.4, login_hours:35.1, planned_leaves:0, unplanned_leaves:1 },
    ],
  },
  {
    profile: { name:"Vikram Rao", id:"EMP-2039", dept:"Transport & Attendance", team:"Route Management — Team B", joinDate:"November 2022", avatar:"VR" },
    tier: "mid",
    monthly: { quality_score:87, account_logs:585, document_logs:1170, processing_time:4.4, pkt_score:74, login_hours:156, planned_leaves:1, unplanned_leaves:2 },
    weekly:  [
      { week:"W18", quality_score:85, account_logs:139, document_logs:279, processing_time:4.6, login_hours:37.2, planned_leaves:0, unplanned_leaves:1 },
      { week:"W19", quality_score:88, account_logs:146, document_logs:292, processing_time:4.3, login_hours:38.4, planned_leaves:1, unplanned_leaves:0 },
      { week:"W20", quality_score:86, account_logs:143, document_logs:286, processing_time:4.5, login_hours:38.0, planned_leaves:0, unplanned_leaves:1 },
      { week:"W21", quality_score:88, account_logs:148, document_logs:296, processing_time:4.2, login_hours:38.7, planned_leaves:0, unplanned_leaves:0 },
    ],
  },
  {
    profile: { name:"Deepa Menon", id:"EMP-2062", dept:"Quality Assurance", team:"QA Review — Team A", joinDate:"April 2023", avatar:"DM" },
    tier: "low",
    monthly: { quality_score:76, account_logs:487, document_logs:975, processing_time:5.8, pkt_score:58, login_hours:141, planned_leaves:3, unplanned_leaves:6 },
    weekly:  [
      { week:"W18", quality_score:74, account_logs:113, document_logs:226, processing_time:6.0, login_hours:33.1, planned_leaves:1, unplanned_leaves:2 },
      { week:"W19", quality_score:77, account_logs:119, document_logs:238, processing_time:5.7, login_hours:34.2, planned_leaves:1, unplanned_leaves:1 },
      { week:"W20", quality_score:75, account_logs:116, document_logs:231, processing_time:5.9, login_hours:33.7, planned_leaves:0, unplanned_leaves:2 },
      { week:"W21", quality_score:76, account_logs:118, document_logs:236, processing_time:5.8, login_hours:34.0, planned_leaves:0, unplanned_leaves:1 },
    ],
  },
];
// ─── TEAM LEADS DATA (Director view only) ────────────────────────────────────
// Two team leads, each managing 3 of the 6 TEAM_MEMBERS above.
// Team leads are scored like members — same metrics, same targets.
// Their "team_avg" is derived from their members at render time.
const TEAM_LEADS = [
  {
    profile: { name:"Kiran Desai", id:"TL-1004", dept:"Document Processing & Call Ops", team:"Team Alpha — Lead", joinDate:"August 2020", avatar:"KD", role:"Team Lead" },
    memberIds: ["EMP-2047","EMP-2031","EMP-2018"], // Aryan, Priya, Ravi
    monthly: { quality_score:91, account_logs:641, document_logs:1283, processing_time:4.1, pkt_score:84, login_hours:162, planned_leaves:1, unplanned_leaves:1 },
    weekly: [
      { week:"W18", quality_score:90, account_logs:153, document_logs:306, processing_time:4.2, login_hours:40.1, planned_leaves:0, unplanned_leaves:0 },
      { week:"W19", quality_score:92, account_logs:159, document_logs:318, processing_time:4.0, login_hours:40.6, planned_leaves:1, unplanned_leaves:0 },
      { week:"W20", quality_score:91, account_logs:156, document_logs:312, processing_time:4.1, login_hours:40.3, planned_leaves:0, unplanned_leaves:1 },
      { week:"W21", quality_score:92, account_logs:161, document_logs:322, processing_time:3.9, login_hours:40.8, planned_leaves:0, unplanned_leaves:0 },
    ],
  },
  {
    profile: { name:"Meena Iyer", id:"TL-1007", dept:"Scheduling, Transport & QA", team:"Team Beta — Lead", joinDate:"March 2021", avatar:"MI", role:"Team Lead" },
    memberIds: ["EMP-2055","EMP-2039","EMP-2062"], // Sneha, Vikram, Deepa
    monthly: { quality_score:83, account_logs:558, document_logs:1116, processing_time:4.9, pkt_score:70, login_hours:152, planned_leaves:2, unplanned_leaves:3 },
    weekly: [
      { week:"W18", quality_score:81, account_logs:131, document_logs:262, processing_time:5.1, login_hours:37.0, planned_leaves:0, unplanned_leaves:1 },
      { week:"W19", quality_score:84, account_logs:138, document_logs:276, processing_time:4.8, login_hours:37.8, planned_leaves:1, unplanned_leaves:1 },
      { week:"W20", quality_score:82, account_logs:134, document_logs:268, processing_time:5.0, login_hours:37.4, planned_leaves:0, unplanned_leaves:1 },
      { week:"W21", quality_score:84, account_logs:137, document_logs:274, processing_time:4.8, login_hours:37.9, planned_leaves:0, unplanned_leaves:0 },
    ],
  },
];

// Helper: compute overall score for a team member monthly snapshot (same logic as EmpOverviewTab)
function memberOverallScore(monthly) {
  const sc = Object.entries(EMP_METRICS_META).map(([k, m]) => {
    const v = monthly[k];
    if (v == null) return 1;
    return Math.min(m.hi ? v / m.target : m.target / v, 1);
  });
  return Math.round((sc.reduce((a, b) => a + b, 0) / sc.length) * 100);
}
function memberTierColor(score, C) {
  return score >= 90 ? C.success : score >= 78 ? C.warn : C.danger;
}
function memberTierLabel(score) {
  return score >= 90 ? "High Performer" : score >= 78 ? "Mid Performer" : "Needs Support";
}
const EMP_INTEGRATIONS = [
  { category:"Communication", tools:[
    { id:"slack",    name:"Slack",             icon:"💬", desc:"Get performance nudges and daily summaries direct to your Slack DMs.",        status:"available" },
    { id:"teams",    name:"Microsoft Teams",   icon:"🟦", desc:"Receive coaching tips and shift reminders directly in Teams.",                 status:"available" },
    { id:"whatsapp", name:"WhatsApp Business", icon:"📱", desc:"Mobile alerts for login reminders and performance milestones.",                status:"coming"   },
  ]},
  { category:"Productivity", tools:[
    { id:"gcal",    name:"Google Calendar", icon:"📅", desc:"Sync planned leaves and shift schedule to your personal calendar.",            status:"available" },
    { id:"notion",  name:"Notion",          icon:"📓", desc:"Push your weekly scorecard to a personal Notion workspace for self-tracking.", status:"coming"   },
    { id:"todoist", name:"Todoist",         icon:"✅", desc:"Convert AI improvement suggestions into actionable daily to-dos.",              status:"coming"   },
  ]},
  { category:"HR & Workforce", tools:[
    { id:"workday",  name:"Workday",   icon:"🏢", desc:"Pull attendance, leave balance, and payroll-related data automatically.", status:"available" },
    { id:"bamboohr", name:"BambooHR",  icon:"🎋", desc:"Sync leave approvals and review history with your HR profile.",           status:"coming"   },
  ]},
];

function empMetricStatus(key, value, C) {
  const m = EMP_METRICS_META[key]; if (!m) return { color:C.textDim, bg:"transparent", label:"—" };
  const ratio = m.hi ? value/m.target : m.target/value;
  if (ratio>=1.0) return { color:C.success, bg:C.successSoft, label:"On Target" };
  if (ratio>=0.90) return { color:C.warn, bg:C.warnSoft, label:"Near Target" };
  return { color:C.danger, bg:C.dangerSoft, label:"Below Target" };
}
function empFmt(v, unit) {
  if (unit==="min"||unit==="hrs") return parseFloat(v).toFixed(1);
  if (unit==="%") return parseFloat(v).toFixed(0);
  return typeof v==="number"&&v%1!==0?v.toFixed(1):String(v);
}

function EmpSparkline({ data, color, height=36, width=110 }) {
  if (!data||data.length<2) return null;
  const min=Math.min(...data), max=Math.max(...data), range=max-min||1;
  const pts=data.map((v,i)=>`${(i/(data.length-1))*width},${height-((v-min)/range)*(height-4)-2}`).join(" ");
  const last=data[data.length-1], prev=data[data.length-2];
  const up=last>prev, dn=last<prev;
  return (
    <div style={{ display:"flex", alignItems:"center", gap:5 }}>
      <svg width={width} height={height} style={{ overflow:"visible" }}>
        <polyline fill="none" stroke={color} strokeWidth="1.5" points={pts} strokeLinecap="round" strokeLinejoin="round" opacity="0.75"/>
        <polyline fill={`${color}18`} stroke="none" points={`0,${height} ${pts} ${width},${height}`}/>
      </svg>
      <span style={{ color:up?color:dn?"#ef4444":"#686890", fontSize:11, fontWeight:700 }}>{up?"↑":dn?"↓":"→"}</span>
    </div>
  );
}

function EmpStatCard({ metricKey, value, sparkData, showSub, C }) {
  const m=EMP_METRICS_META[metricKey]; if (!m) return null;
  const status=empMetricStatus(metricKey, parseFloat(value), C);
  return (
    <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:11, padding:"14px 16px", flex:"1 1 150px", animation:"fadeIn 0.35s ease" }}>
      <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:600, marginBottom:8 }}>{m.label}</div>
      <div style={{ display:"flex", alignItems:"baseline", gap:4, marginBottom:6 }}>
        <span style={{ color:C.text, fontSize:22, fontWeight:800, fontFamily:"monospace" }}>{empFmt(parseFloat(value), m.unit)}</span>
        {m.unit&&<span style={{ color:C.textDim, fontSize:12 }}>{m.unit}</span>}
      </div>
      {sparkData&&<EmpSparkline data={sparkData} color={status.color}/>}
      <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:6 }}>
        <span style={{ background:status.bg, color:status.color, border:`1px solid ${status.color}33`, borderRadius:4, padding:"1px 7px", fontSize:9, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.06em" }}>{status.label}</span>
        {showSub&&<span style={{ color:C.textMuted, fontSize:10 }}>Target: {m.target}{m.unit}</span>}
      </div>
    </div>
  );
}

function EmpPerfTable({ data, C }) {
  const keys=Object.keys(EMP_METRICS_META);
  const labelKey=Object.keys(data[0])[0];
  return (
    <div style={{ overflowX:"auto", border:`1px solid ${C.border}`, borderRadius:10 }}>
      <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
        <thead><tr style={{ background:C.surfaceHigh }}>
          <th style={{ padding:"9px 14px", textAlign:"left", color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.07em", fontWeight:700, borderBottom:`1px solid ${C.border}`, whiteSpace:"nowrap" }}>{labelKey.charAt(0).toUpperCase()+labelKey.slice(1)}</th>
          {keys.map(k=><th key={k} style={{ padding:"9px 12px", textAlign:"right", color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.07em", fontWeight:700, borderBottom:`1px solid ${C.border}`, whiteSpace:"nowrap" }}>{EMP_METRICS_META[k].label}</th>)}
        </tr></thead>
        <tbody>{data.map((row,i)=>(
          <tr key={i} style={{ borderBottom:`1px solid ${C.border}22` }}>
            <td style={{ padding:"9px 14px", color:C.text, fontWeight:600, fontSize:12, whiteSpace:"nowrap" }}>{row[labelKey]}</td>
            {keys.map(k=>{ const st=empMetricStatus(k,row[k],C); const m=EMP_METRICS_META[k]; return (
              <td key={k} style={{ padding:"9px 12px", textAlign:"right", fontFamily:"monospace", fontSize:12 }}>
                <span style={{ color:st.color, fontWeight:600 }}>{empFmt(row[k],m.unit)}{m.unit&&m.unit!==""?m.unit:""}</span>
              </td>
            ); })}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function EmpAICoach({ period, data, C }) {
  const [insight,setInsight]=useState(null);
  const [loading,setLoading]=useState(false);
  const [done,setDone]=useState(false);

  const generate=async()=>{
    setLoading(true); setDone(true);
    try {
      const latest=data[data.length-1];
      const summary=Object.entries(EMP_METRICS_META).map(([k,m])=>{
        const st=empMetricStatus(k,latest[k],C);
        return `${m.label}: ${empFmt(latest[k],m.unit)}${m.unit} (target:${m.target}${m.unit}) — ${st.label}`;
      }).join("\n");
      const res=await fetch("/api/claude",{
        method:"POST", headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:1000,
          messages:[{ role:"user", content:
            `You are a performance coach for ${EMP_PROFILE.name}, a Document Processing employee. He is a mid-level performer.\n\nBased on this ${period} data:\n${summary}\n\nWrite a short, specific, encouraging coaching note. Use EXACTLY this format:\nSTRENGTHS: [2 sentences — what he's doing well with specific numbers]\nFOCUS AREAS: [2 sentences — what needs improvement with specific targets]\nTHIS WEEK: [1 actionable sentence — the single most impactful thing to do right now]\nGOAL: [1 sentence — a realistic specific target for next ${period}]\n\nReference actual metric values. Be encouraging but direct. No markdown bold or bullets.`
          }] })
      });
      const d=await res.json();
      setInsight(d.content?.map(c=>c.text||"").join("")||"Unable to generate insight.");
    } catch(e) { setInsight(`⚠ ${e.message}`); }
    setLoading(false);
  };

  return (
    <div style={{ marginTop:20 }}>
      {loading&&(
        <div style={{ display:"flex", alignItems:"center", gap:10, padding:"14px 16px", background:C.accentSoft, border:`1px solid ${C.accent}33`, borderRadius:10 }}>
          <div style={{ width:16, height:16, border:`2px solid ${C.accent}30`, borderTop:`2px solid ${C.accent}`, borderRadius:"50%", animation:"spin 0.8s linear infinite", flexShrink:0 }}/>
          <span style={{ color:C.accent, fontSize:13 }}>Analysing your performance…</span>
        </div>
      )}
      {insight&&!loading&&(
        <div style={{ background:C.purpleSoft, border:`1px solid ${C.purple}44`, borderRadius:12, padding:"18px 20px", animation:"fadeIn 0.35s ease" }}>
          <div style={{ color:C.purple, fontSize:10, textTransform:"uppercase", letterSpacing:"0.09em", fontWeight:700, marginBottom:14 }}>◎ AI Performance Coach · {period.charAt(0).toUpperCase()+period.slice(1)} Analysis</div>
          {insight.split("\n").filter(Boolean).map((line,i)=>{
            const isLabel=line.match(/^(STRENGTHS|FOCUS AREAS|THIS WEEK|GOAL):/);
            return <div key={i} style={{ color:isLabel?C.purple:C.text, fontSize:isLabel?10:13, fontWeight:isLabel?700:400, textTransform:isLabel?"uppercase":"none", letterSpacing:isLabel?"0.08em":"normal", lineHeight:1.75, marginBottom:isLabel?4:12, marginTop:isLabel&&i>0?10:0 }}>{line}</div>;
          })}
          <div style={{ marginTop:10, paddingTop:10, borderTop:`1px solid ${C.border}`, color:C.textDim, fontSize:10 }}>AI-generated coaching · Clarix Performance Intelligence</div>
        </div>
      )}
      {!done&&!loading&&<button onClick={generate} style={{ background:C.purple, color:"#fff", border:"none", borderRadius:8, padding:"10px 20px", fontSize:13, fontWeight:600, cursor:"pointer", display:"flex", alignItems:"center", gap:7, transition:"opacity 0.15s" }} onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}><span>◎</span> Get AI Coaching Insight</button>}
      {done&&!loading&&<button onClick={()=>{setInsight(null);setDone(false);}} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:8, padding:"7px 14px", fontSize:12, cursor:"pointer", marginTop:6 }}>↺ Refresh Analysis</button>}
    </div>
  );
}

// ─── TEAM PERFORMANCE DASHBOARD (Team Lead & Director) ───────────────────────
function MemberMiniSparkline({ data, color, width=64, height=22 }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - ((v - min) / range) * (height - 3) - 1}`).join(" ");
  return (
    <svg width={width} height={height} style={{ overflow:"visible" }}>
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={pts} strokeLinecap="round" strokeLinejoin="round" opacity="0.8"/>
    </svg>
  );
}

function TeamPerformanceDashboard({ C, viewRole }) {
  const [selected,   setSelected]   = useState(null);
  const [tlSelected, setTlSelected] = useState(null);
  const [aiText,     setAiText]     = useState({});
  const [aiLoad,     setAiLoad]     = useState({});
  const [aiDone,     setAiDone]     = useState({});

  const generateInsight = async (entity, entityRole) => {
    const key = entity.profile.id;
    setAiLoad(p=>({...p,[key]:true})); setAiDone(p=>({...p,[key]:true}));
    try {
      const score = memberOverallScore(entity.monthly);
      const label = memberTierLabel(score);
      const summary = Object.entries(EMP_METRICS_META).map(([k,m]) => {
        const v = entity.monthly[k]; if (v == null) return null;
        const ratio = m.hi ? v/m.target : m.target/v;
        const status = ratio>=1?"On Target":ratio>=0.9?"Near Target":"Below Target";
        return `${m.label}: ${empFmt(v,m.unit)}${m.unit} (target: ${m.target}${m.unit}) — ${status}`;
      }).filter(Boolean).join("\n");
      const viewerRole = viewRole==="director" ? "Director/Executive" : "Team Lead";
      const subjectRole = entityRole==="teamlead" ? "Team Lead" : "team member";
      let teamContext = "";
      if (entityRole==="teamlead") {
        const members = TEAM_MEMBERS.filter(m=>entity.memberIds.includes(m.profile.id));
        const avgScore = Math.round(members.reduce((a,m)=>a+memberOverallScore(m.monthly),0)/members.length);
        teamContext = `\nThis team lead manages ${members.length} members with a team average score of ${avgScore}. Members: ${members.map(m=>m.profile.name).join(", ")}.`;
      }
      const res = await fetch("/api/claude",{
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ model:"claude-sonnet-4-20250514", max_tokens:600,
          messages:[{ role:"user", content:
            `You are a performance intelligence assistant helping a ${viewerRole} review ${subjectRole} ${entity.profile.name} (${label}, Overall Score: ${score}).${teamContext}\n\nMonthly performance snapshot:\n${summary}\n\nWrite a concise performance briefing in EXACTLY this format:\nSTATUS: [1 sentence — overall performance tier and trend]\nSTRENGTHS: [1-2 sentences — what they are doing well with numbers]\nFOCUS: [1-2 sentences — the specific metric gap needing attention]\n→ ACTION: [1 sentence — what the ${viewerRole} should do in the next 2 weeks]\n\nReference actual numbers. No markdown or bullets. Be direct.`
          }]
        })
      });
      const d = await res.json();
      setAiText(p=>({...p,[key]:d.content?.map(c=>c.text||"").join("")||"Unable to generate."}));
    } catch(e) { setAiText(p=>({...p,[entity.profile.id]:`⚠ ${e.message}`})); }
    setAiLoad(p=>({...p,[entity.profile.id]:false}));
  };

  const ExpandedDetail = ({ entity, entityRole }) => {
    const key = entity.profile.id;
    return (
      <div style={{ borderTop:`1px solid ${C.border}`, padding:"16px 18px", animation:"fadeIn 0.25s ease" }}>
        <div style={{ display:"flex", gap:10, marginBottom:14, flexWrap:"wrap" }}>
          {[
            { label: entityRole==="teamlead"?"Manages":"Team", val:entity.profile.team },
            { label:"Joined",  val:entity.profile.joinDate },
            { label:"Dept",    val:entity.profile.dept },
          ].map(f=>(
            <div key={f.label} style={{ background:C.surfaceHigh, border:`1px solid ${C.border}`, borderRadius:7, padding:"7px 11px", flex:"1 1 120px" }}>
              <div style={{ color:C.textDim, fontSize:9, textTransform:"uppercase", letterSpacing:"0.07em", fontWeight:600, marginBottom:3 }}>{f.label}</div>
              <div style={{ color:C.text, fontSize:11, fontWeight:600 }}>{f.val}</div>
            </div>
          ))}
        </div>
        <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:600, marginBottom:8 }}>
          Monthly Performance Snapshot
          <span style={{ color:C.textMuted, fontSize:9, marginLeft:8, textTransform:"none", letterSpacing:0 }}>(PKT = once-monthly assessment)</span>
        </div>
        <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:16 }}>
          {Object.entries(EMP_METRICS_META).map(([k,meta])=>{
            const v = entity.monthly[k]; if (v==null) return null;
            const ratio = meta.hi ? v/meta.target : meta.target/v;
            const st = ratio>=1?{color:C.success,bg:C.successSoft,label:"On Target"}
                     : ratio>=0.9?{color:C.warn,bg:C.warnSoft,label:"Near Target"}
                     : {color:C.danger,bg:C.dangerSoft,label:"Below Target"};
            return (
              <div key={k} style={{ background:C.surfaceHigh, border:`1px solid ${C.border}`, borderRadius:9, padding:"10px 12px", flex:"1 1 130px" }}>
                <div style={{ color:C.textDim, fontSize:9, textTransform:"uppercase", letterSpacing:"0.07em", fontWeight:600, marginBottom:6 }}>{meta.label}</div>
                <div style={{ display:"flex", alignItems:"baseline", gap:3, marginBottom:5 }}>
                  <span style={{ color:C.text, fontFamily:"monospace", fontWeight:800, fontSize:18 }}>{empFmt(v,meta.unit)}</span>
                  {meta.unit&&<span style={{ color:C.textDim, fontSize:11 }}>{meta.unit}</span>}
                </div>
                <span style={{ background:st.bg, color:st.color, border:`1px solid ${st.color}33`, borderRadius:4, padding:"1px 6px", fontSize:9, fontWeight:700, textTransform:"uppercase" }}>{st.label}</span>
              </div>
            );
          })}
        </div>
        <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:600, marginBottom:8 }}>4-Week Weekly Trend</div>
        <div style={{ overflowX:"auto", border:`1px solid ${C.border}`, borderRadius:9, marginBottom:16 }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:11 }}>
            <thead><tr style={{ background:C.surfaceHigh }}>
              {["Week","Quality","Acc. Logs","Doc Logs","Proc. Time","Login Hrs","Unpl. Leave"].map(h=>(
                <th key={h} style={{ padding:"7px 10px", textAlign:h==="Week"?"left":"right", color:C.textDim, fontSize:9, textTransform:"uppercase", letterSpacing:"0.06em", fontWeight:700, borderBottom:`1px solid ${C.border}`, whiteSpace:"nowrap" }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {entity.weekly.map((w,i)=>{
                const qRatio = w.quality_score / EMP_METRICS_META.quality_score.target;
                const qColor = qRatio>=1?C.success:qRatio>=0.9?C.warn:C.danger;
                return (
                  <tr key={i} style={{ borderBottom:`1px solid ${C.border}22` }}>
                    <td style={{ padding:"7px 12px", color:C.textDim, fontWeight:600, fontSize:11 }}>{w.week}</td>
                    <td style={{ padding:"7px 10px", textAlign:"right", fontFamily:"monospace", fontSize:11, color:qColor, fontWeight:700 }}>{w.quality_score}%</td>
                    <td style={{ padding:"7px 10px", textAlign:"right", fontFamily:"monospace", fontSize:11, color:C.text }}>{w.account_logs}</td>
                    <td style={{ padding:"7px 10px", textAlign:"right", fontFamily:"monospace", fontSize:11, color:C.text }}>{w.document_logs}</td>
                    <td style={{ padding:"7px 10px", textAlign:"right", fontFamily:"monospace", fontSize:11, color:w.processing_time>EMP_METRICS_META.processing_time.target?C.danger:C.success }}>{w.processing_time.toFixed(1)}m</td>
                    <td style={{ padding:"7px 10px", textAlign:"right", fontFamily:"monospace", fontSize:11, color:C.text }}>{w.login_hours.toFixed(1)}h</td>
                    <td style={{ padding:"7px 10px", textAlign:"right", fontFamily:"monospace", fontSize:11, color:w.unplanned_leaves>0?C.warn:C.textDim }}>{w.unplanned_leaves}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {aiLoad[key]&&(
          <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 14px", background:C.accentSoft, border:`1px solid ${C.accent}33`, borderRadius:9 }}>
            <div style={{ width:14, height:14, border:`2px solid ${C.accent}30`, borderTop:`2px solid ${C.accent}`, borderRadius:"50%", animation:"spin 0.8s linear infinite", flexShrink:0 }}/>
            <span style={{ color:C.accent, fontSize:12 }}>Generating performance briefing…</span>
          </div>
        )}
        {aiText[key]&&!aiLoad[key]&&(
          <div style={{ background:C.purpleSoft, border:`1px solid ${C.purple}44`, borderRadius:10, padding:"14px 16px", animation:"fadeIn 0.3s ease" }}>
            <div style={{ color:C.purple, fontSize:9, textTransform:"uppercase", letterSpacing:"0.09em", fontWeight:700, marginBottom:10 }}>◎ AI Performance Briefing · {entity.profile.name}</div>
            {aiText[key].split("\n").filter(Boolean).map((line,i)=>{
              const isLabel = line.match(/^(STATUS|STRENGTHS|FOCUS|→ ACTION):/);
              return <div key={i} style={{ color:isLabel?C.purple:C.text, fontSize:isLabel?10:12, fontWeight:isLabel?700:400, textTransform:isLabel?"uppercase":"none", letterSpacing:isLabel?"0.07em":"normal", lineHeight:1.75, marginBottom:isLabel?3:10, marginTop:isLabel&&i>0?8:0 }}>{line}</div>;
            })}
            <div style={{ marginTop:8, paddingTop:8, borderTop:`1px solid ${C.border}`, color:C.textDim, fontSize:9 }}>AI-generated · Clarix Team Intelligence</div>
          </div>
        )}
        {!aiDone[key]&&!aiLoad[key]&&(
          <button onClick={()=>generateInsight(entity, entityRole)}
            style={{ background:C.purple, color:"#fff", border:"none", borderRadius:8, padding:"9px 18px", fontSize:12, fontWeight:600, cursor:"pointer", display:"flex", alignItems:"center", gap:7 }}>
            <span>◎</span> Generate Performance Briefing
          </button>
        )}
        {aiDone[key]&&!aiLoad[key]&&(
          <button onClick={()=>{setAiText(p=>({...p,[key]:null}));setAiDone(p=>({...p,[key]:false}));}}
            style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:7, padding:"6px 13px", fontSize:11, cursor:"pointer", marginTop:8 }}>↺ Refresh</button>
        )}
      </div>
    );
  };

  const EntityCard = ({ entity, entityRole, isOpen, onToggle, badgeExtra }) => {
    const score = memberOverallScore(entity.monthly);
    const sColor = memberTierColor(score, C);
    const sLabel = memberTierLabel(score);
    const weeklyQuality = entity.weekly.map(w=>w.quality_score);
    const isLead = entityRole==="teamlead";
    return (
      <div style={{ background:isLead?C.surfaceHigh:C.surface, border:`1px solid ${isOpen?sColor+"66":isLead?C.accent+"33":C.border}`, borderRadius:12, overflow:"hidden", transition:"border-color 0.15s" }}>
        <div onClick={onToggle} style={{ padding:isLead?"15px 18px":"13px 16px", cursor:"pointer", display:"flex", alignItems:"center", gap:14, flexWrap:"wrap" }}>
          <div style={{ width:isLead?42:36, height:isLead?42:36, borderRadius:"50%", background:`${sColor}20`, border:`2px solid ${sColor}55`, display:"flex", alignItems:"center", justifyContent:"center", color:sColor, fontWeight:800, fontSize:isLead?13:11, flexShrink:0 }}>
            {entity.profile.avatar}
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ display:"flex", alignItems:"center", gap:7, flexWrap:"wrap" }}>
              <span style={{ color:C.text, fontWeight:700, fontSize:isLead?14:13 }}>{entity.profile.name}</span>
              {isLead&&<span style={{ background:C.accentSoft, color:C.accent, border:`1px solid ${C.accent}44`, borderRadius:4, padding:"1px 7px", fontSize:9, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.06em" }}>Team Lead</span>}
            </div>
            <div style={{ color:C.textDim, fontSize:11, marginTop:1 }}>{entity.profile.dept} · {entity.profile.id}</div>
            {badgeExtra&&<div style={{ color:C.textMuted, fontSize:10, marginTop:2 }}>{badgeExtra}</div>}
          </div>
          <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:3, flexShrink:0 }}>
            <MemberMiniSparkline data={weeklyQuality} color={sColor}/>
            <span style={{ color:C.textMuted, fontSize:9 }}>4-week quality</span>
          </div>
          <div style={{ textAlign:"center", flexShrink:0 }}>
            <div style={{ fontFamily:"monospace", fontWeight:800, fontSize:isLead?24:20, color:sColor, lineHeight:1 }}>{score}</div>
            <div style={{ background:`${sColor}18`, color:sColor, border:`1px solid ${sColor}44`, borderRadius:4, padding:"1px 7px", fontSize:9, fontWeight:700, marginTop:3, whiteSpace:"nowrap" }}>{sLabel}</div>
          </div>
          <span style={{ color:C.textDim, fontSize:11, flexShrink:0 }}>{isOpen?"▲":"▼"}</span>
        </div>
        {isOpen&&<ExpandedDetail entity={entity} entityRole={entityRole}/>}
      </div>
    );
  };

  const allEntities = viewRole==="director" ? [...TEAM_LEADS, ...TEAM_MEMBERS] : TEAM_MEMBERS;
  const highCount  = allEntities.filter(e=>memberOverallScore(e.monthly)>=90).length;
  const midCount   = allEntities.filter(e=>{ const s=memberOverallScore(e.monthly); return s>=78&&s<90; }).length;
  const lowCount   = allEntities.filter(e=>memberOverallScore(e.monthly)<78).length;
  const avgScore   = Math.round(allEntities.reduce((a,e)=>a+memberOverallScore(e.monthly),0)/allEntities.length);

  return (
    <div style={{ animation:"fadeIn 0.3s ease" }}>
      <div style={{ marginBottom:18 }}>
        <h3 style={{ fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:700, fontSize:17, color:C.text, margin:"0 0 4px" }}>
          ◈ Team Performance Dashboard
        </h3>
        <div style={{ color:C.textDim, fontSize:12 }}>
          {viewRole==="director"
            ? `${TEAM_LEADS.length} team leads · ${TEAM_MEMBERS.length} members · Monthly snapshot · PKT assessed once per month`
            : `${TEAM_MEMBERS.length} team members · Monthly snapshot · PKT assessed once per month`}
        </div>
      </div>

      <div style={{ display:"flex", gap:9, flexWrap:"wrap", marginBottom:20 }}>
        {[
          { label:"High Performers", val:highCount,  bg:C.successSoft, color:C.success, bord:C.success },
          { label:"Mid Performers",  val:midCount,   bg:C.warnSoft,    color:C.warn,    bord:C.warn    },
          { label:"Needs Support",   val:lowCount,   bg:C.dangerSoft,  color:C.danger,  bord:C.danger  },
          { label:"Avg Score",       val:avgScore,   bg:C.accentSoft,  color:C.accent,  bord:C.accent  },
        ].map(s=>(
          <div key={s.label} style={{ background:s.bg, border:`1px solid ${s.bord}44`, borderRadius:10, padding:"12px 15px", flex:"1 1 110px" }}>
            <div style={{ color:s.color, fontSize:9, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:700, marginBottom:4 }}>{s.label}</div>
            <div style={{ color:s.color, fontSize:24, fontWeight:800, fontFamily:"monospace" }}>{s.val}</div>
          </div>
        ))}
      </div>

      {viewRole==="director" && (
        <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
          {TEAM_LEADS.map(tl=>{
            const tlOpen = tlSelected===tl.profile.id;
            const tlMembers = TEAM_MEMBERS.filter(m=>tl.memberIds.includes(m.profile.id));
            const tlMemberAvg = Math.round(tlMembers.reduce((a,m)=>a+memberOverallScore(m.monthly),0)/tlMembers.length);
            return (
              <div key={tl.profile.id}>
                <EntityCard
                  entity={tl}
                  entityRole="teamlead"
                  isOpen={tlOpen}
                  onToggle={()=>setTlSelected(tlOpen?null:tl.profile.id)}
                  badgeExtra={`Team avg score: ${tlMemberAvg} · ${tlMembers.length} direct reports`}
                />
                <div style={{ marginTop:10, marginLeft:22, display:"flex", flexDirection:"column", gap:8 }}>
                  <div style={{ color:C.textDim, fontSize:9, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:700, paddingLeft:4, marginBottom:2, display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ display:"inline-block", width:16, height:1, background:C.accent+"44", verticalAlign:"middle" }}/>
                    Direct Reports — {tl.profile.name}
                  </div>
                  {tlMembers.map(member=>{
                    const isOpen = selected===member.profile.id;
                    return (
                      <EntityCard
                        key={member.profile.id}
                        entity={member}
                        entityRole="member"
                        isOpen={isOpen}
                        onToggle={()=>setSelected(isOpen?null:member.profile.id)}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {viewRole!=="director" && (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {TEAM_MEMBERS.map(member=>{
            const isOpen = selected===member.profile.id;
            return (
              <EntityCard
                key={member.profile.id}
                entity={member}
                entityRole="member"
                isOpen={isOpen}
                onToggle={()=>setSelected(isOpen?null:member.profile.id)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function EmpOverviewTab({ C }) {
  const latest=EMP_WEEKLY[EMP_WEEKLY.length-1];
  const spark=k=>EMP_WEEKLY.map(w=>w[k]);
  const overallScore=(()=>{
    const sc=Object.entries(EMP_METRICS_META).map(([k,m])=>Math.min(m.hi?latest[k]/m.target:m.target/latest[k],1));
    return Math.round((sc.reduce((a,b)=>a+b,0)/sc.length)*100);
  })();
  const sColor=overallScore>=90?C.success:overallScore>=75?C.warn:C.danger;
  const sLabel=overallScore>=90?"High Performer":overallScore>=75?"Mid Performer":"Needs Support";
  return (
    <div style={{ animation:"fadeIn 0.3s ease" }}>
      <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, padding:"20px 22px", marginBottom:20, display:"flex", alignItems:"center", gap:20, flexWrap:"wrap" }}>
        <div style={{ width:54, height:54, borderRadius:"50%", background:`${C.accent}22`, border:`2px solid ${C.accent}44`, display:"flex", alignItems:"center", justifyContent:"center", color:C.accent, fontWeight:800, fontSize:17, flexShrink:0 }}>{EMP_PROFILE.avatar}</div>
        <div style={{ flex:1 }}>
          <div style={{ fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:800, fontSize:18, color:C.text }}>{EMP_PROFILE.name}</div>
          <div style={{ color:C.textDim, fontSize:12, marginTop:2 }}>{EMP_PROFILE.dept} · {EMP_PROFILE.team}</div>
          <div style={{ color:C.textMuted, fontSize:11, marginTop:1 }}>ID: {EMP_PROFILE.id} · Joined {EMP_PROFILE.joinDate}</div>
        </div>
        <div style={{ textAlign:"center", flexShrink:0 }}>
          <div style={{ fontFamily:"monospace", fontWeight:800, fontSize:36, color:sColor, lineHeight:1 }}>{overallScore}</div>
          <div style={{ color:sColor, fontSize:9, textTransform:"uppercase", letterSpacing:"0.1em", fontWeight:700, marginTop:2 }}>Overall Score</div>
          <div style={{ background:`${sColor}18`, color:sColor, border:`1px solid ${sColor}44`, borderRadius:5, padding:"2px 9px", fontSize:10, fontWeight:700, marginTop:5 }}>{sLabel}</div>
        </div>
      </div>
      <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginBottom:20 }}>
        {["quality_score","pkt_score","document_logs","processing_time","login_hours","unplanned_leaves"].map(k=>(
          <EmpStatCard key={k} metricKey={k} value={latest[k]} sparkData={spark(k)} C={C}/>
        ))}
      </div>
      <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:600, marginBottom:4 }}>◎ AI Performance Coach</div>
      <div style={{ color:C.textDim, fontSize:12, marginBottom:0 }}>Personalised coaching based on your current week's performance.</div>
      <EmpAICoach period="weekly" data={EMP_WEEKLY} C={C}/>
    </div>
  );
}

function EmpDailyTab({ C }) {
  const today=EMP_DAILY[EMP_DAILY.length-1];
  return (
    <div style={{ animation:"fadeIn 0.3s ease" }}>
      <div style={{ marginBottom:14 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:2 }}>
          <span style={{ color:C.accent, fontSize:14 }}>◉</span>
          <h3 style={{ fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:700, fontSize:16, color:C.text }}>Today's Performance</h3>
        </div>
        <div style={{ color:C.textDim, fontSize:12 }}>{EMP_PROFILE.name} · {EMP_PROFILE.dept} · {new Date().toLocaleDateString("en-IN",{weekday:"long",day:"numeric",month:"long"})}</div>
      </div>
      <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginBottom:20 }}>
        {Object.keys(EMP_METRICS_META).map(k=><EmpStatCard key={k} metricKey={k} value={today[k]} showSub C={C}/>)}
      </div>
      <div style={{ marginBottom:14 }}>
        <h3 style={{ fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:700, fontSize:16, color:C.text, marginBottom:2 }}>◈ This Week's Daily Breakdown</h3>
        <div style={{ color:C.textDim, fontSize:12 }}>All five working days, colour-coded against target.</div>
      </div>
      <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:"18px 20px", marginBottom:20 }}>
        {Object.entries(EMP_METRICS_META).slice(0,4).map(([key,m])=>{
          const maxVal=Math.max(...EMP_DAILY.map(d=>d[key]))*1.2;
          return (
            <div key={key} style={{ marginBottom:16 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                <span style={{ color:C.textDim, fontSize:11, fontWeight:600 }}>{m.label}</span>
                <span style={{ color:C.textMuted, fontSize:10 }}>Target: {m.target}{m.unit}</span>
              </div>
              <div style={{ display:"flex", gap:5, alignItems:"flex-end", height:44 }}>
                {EMP_DAILY.map((d,i)=>{
                  const st=empMetricStatus(key,d[key],C);
                  const pct=Math.min((d[key]/maxVal)*100,100);
                  const isToday=i===EMP_DAILY.length-1;
                  return (
                    <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:3 }}>
                      <span style={{ color:C.textDim, fontSize:9, fontWeight:isToday?700:400 }}>{empFmt(d[key],m.unit)}</span>
                      <div style={{ width:"100%", height:28, background:C.surfaceHigh, borderRadius:4, display:"flex", alignItems:"flex-end", overflow:"hidden" }}>
                        <div style={{ width:"100%", height:`${pct}%`, background:st.color, borderRadius:4, opacity:isToday?1:0.6, transition:"height 0.4s ease" }}/>
                      </div>
                      <span style={{ color:isToday?C.accent:C.textMuted, fontSize:9, fontWeight:isToday?700:400 }}>{d.day}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:600, marginBottom:4 }}>◎ AI Coaching — Today</div>
      <EmpAICoach period="daily" data={EMP_DAILY} C={C}/>
    </div>
  );
}

function EmpWeeklyTab({ C }) {
  return (
    <div style={{ animation:"fadeIn 0.3s ease" }}>
      <h3 style={{ fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:700, fontSize:16, color:C.text, marginBottom:2 }}>◈ Weekly Performance Record</h3>
      <div style={{ color:C.textDim, fontSize:12, marginBottom:14 }}>Last 4 weeks including current week (MTD).</div>
      <EmpPerfTable data={EMP_WEEKLY} C={C}/>
      <div style={{ marginTop:20, marginBottom:10 }}>
        <h3 style={{ fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:700, fontSize:16, color:C.text, marginBottom:2 }}>◉ Week-on-Week Trends</h3>
        <div style={{ color:C.textDim, fontSize:12 }}>How each metric has moved across the past 4 weeks.</div>
      </div>
      <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginBottom:20 }}>
        {Object.entries(EMP_METRICS_META).map(([key,m])=>{
          const vals=EMP_WEEKLY.map(w=>w[key]);
          const latest=vals[vals.length-1];
          const st=empMetricStatus(key,latest,C);
          const delta=latest-vals[0];
          const improving=m.hi?delta>0:delta<0;
          return (
            <div key={key} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:10, padding:"13px 15px", flex:"1 1 150px" }}>
              <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.07em", fontWeight:600, marginBottom:8 }}>{m.label}</div>
              <EmpSparkline data={vals} color={st.color} width={100} height={32}/>
              <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:7 }}>
                <span style={{ color:st.color, fontFamily:"monospace", fontWeight:700, fontSize:14 }}>{empFmt(latest,m.unit)}{m.unit}</span>
                <span style={{ color:improving?C.success:C.danger, fontSize:10, fontWeight:600 }}>{improving?"↑":"↓"} {Math.abs(delta).toFixed(1)}{m.unit}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:600, marginBottom:4 }}>◎ AI Coaching — Weekly</div>
      <EmpAICoach period="weekly" data={EMP_WEEKLY} C={C}/>
    </div>
  );
}

function EmpMonthlyTab({ C }) {
  return (
    <div style={{ animation:"fadeIn 0.3s ease" }}>
      <h3 style={{ fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:700, fontSize:16, color:C.text, marginBottom:2 }}>◈ Monthly Performance Record</h3>
      <div style={{ color:C.textDim, fontSize:12, marginBottom:14 }}>Feb – May 2025, May is month-to-date.</div>
      <EmpPerfTable data={EMP_MONTHLY} C={C}/>
      <div style={{ marginTop:20, marginBottom:10 }}>
        <h3 style={{ fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:700, fontSize:16, color:C.text, marginBottom:2 }}>◉ Month-over-Month Progress</h3>
        <div style={{ color:C.textDim, fontSize:12 }}>Colour indicates trend direction for each metric.</div>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(190px,1fr))", gap:10, marginBottom:20 }}>
        {Object.entries(EMP_METRICS_META).map(([key,m])=>{
          const vals=EMP_MONTHLY.map(mo=>mo[key]);
          const latest=vals[vals.length-1], prev=vals[vals.length-2];
          const delta=latest-prev, improving=m.hi?delta>0:delta<0;
          const st=empMetricStatus(key,latest,C);
          return (
            <div key={key} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:10, padding:"14px 16px" }}>
              <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.07em", fontWeight:600, marginBottom:6 }}>{m.label}</div>
              <div style={{ display:"flex", alignItems:"baseline", gap:5, marginBottom:6 }}>
                <span style={{ color:st.color, fontFamily:"monospace", fontWeight:800, fontSize:20 }}>{empFmt(latest,m.unit)}</span>
                <span style={{ color:C.textDim, fontSize:11 }}>{m.unit}</span>
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                <span style={{ color:delta===0?C.textDim:improving?C.success:C.danger, fontSize:12, fontWeight:700 }}>{delta===0?"→":improving?"▲":"▼"} {Math.abs(delta).toFixed(1)}{m.unit}</span>
                <span style={{ color:C.textMuted, fontSize:10 }}>vs last month</span>
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:600, marginBottom:4 }}>◎ AI Coaching — Monthly</div>
      <EmpAICoach period="monthly" data={EMP_MONTHLY} C={C}/>
    </div>
  );
}

function EmpIntegrationsTab({ C }) {
  const [connected,setConnected]=useState({});
  const [toast,setToast]=useState(null);
  const [reqModal,setReqModal]=useState(false);
  const [reqTool,setReqTool]=useState("");
  const [reqEmail,setReqEmail]=useState("");
  const [submitted,setSubmitted]=useState([]);
  const showToast=msg=>{setToast(msg);setTimeout(()=>setToast(null),3000);};
  const toggle=(id,name)=>{setConnected(p=>({...p,[id]:!p[id]}));showToast(connected[id]?`${name} disconnected`:`${name} connected ✓`);};
  const submitReq=()=>{if(!reqTool.trim())return;setSubmitted(p=>[...p,reqTool]);showToast(`"${reqTool}" request submitted — we'll prioritise it!`);setReqTool("");setReqEmail("");setReqModal(false);};
  const totalConn=Object.values(connected).filter(Boolean).length;
  return (
    <div style={{ animation:"fadeIn 0.3s ease" }}>
      {toast&&<div style={{ position:"fixed", bottom:20, right:20, background:C.accent, color:"#fff", borderRadius:10, padding:"11px 18px", fontSize:13, fontWeight:600, zIndex:9999, animation:"fadeIn 0.2s ease", boxShadow:"0 6px 24px rgba(0,0,0,0.18)" }}>✓ {toast}</div>}
      {reqModal&&(
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.72)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }} onClick={()=>setReqModal(false)}>
          <div onClick={e=>e.stopPropagation()} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, padding:22, width:"100%", maxWidth:400 }}>
            <h3 style={{ fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:700, fontSize:16, marginBottom:14 }}>Request an Integration</h3>
            <div style={{ color:C.textDim, fontSize:11, textTransform:"uppercase", letterSpacing:"0.07em", fontWeight:600, marginBottom:6 }}>Tool Name *</div>
            <input value={reqTool} onChange={e=>setReqTool(e.target.value)} placeholder="e.g. Jira, Trello, Asana..." style={{ background:C.surfaceHigh, border:`1px solid ${C.border}`, color:C.text, borderRadius:8, padding:"9px 12px", fontSize:13, width:"100%", fontFamily:"inherit", outline:"none", marginBottom:12 }}/>
            <div style={{ color:C.textDim, fontSize:11, textTransform:"uppercase", letterSpacing:"0.07em", fontWeight:600, marginBottom:6 }}>Your Email (optional)</div>
            <input type="email" value={reqEmail} onChange={e=>setReqEmail(e.target.value)} placeholder="you@company.com" style={{ background:C.surfaceHigh, border:`1px solid ${C.border}`, color:C.text, borderRadius:8, padding:"9px 12px", fontSize:13, width:"100%", fontFamily:"inherit", outline:"none", marginBottom:18 }}/>
            <div style={{ display:"flex", gap:9, justifyContent:"flex-end" }}>
              <button onClick={()=>setReqModal(false)} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:7, padding:"8px 16px", fontSize:12, cursor:"pointer" }}>Cancel</button>
              <button onClick={submitReq} disabled={!reqTool.trim()} style={{ background:reqTool.trim()?C.accent:C.surfaceHigh, color:reqTool.trim()?"#fff":C.textMuted, border:"none", borderRadius:7, padding:"8px 18px", fontSize:12, fontWeight:700, cursor:reqTool.trim()?"pointer":"not-allowed" }}>Submit →</button>
            </div>
          </div>
        </div>
      )}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10, marginBottom:20 }}>
        <div>
          <h3 style={{ fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:700, fontSize:16, color:C.text }}>⚡ Integrations</h3>
          <div style={{ color:C.textDim, fontSize:12 }}>{totalConn} connected · Connect tools to receive performance alerts and reminders.</div>
        </div>
        <button onClick={()=>setReqModal(true)} style={{ background:C.accent, color:"#fff", border:"none", borderRadius:8, padding:"8px 16px", fontSize:12, fontWeight:700, cursor:"pointer" }}>＋ Request Integration</button>
      </div>
      {submitted.length>0&&(
        <div style={{ background:C.purpleSoft, border:`1px solid ${C.purple}44`, borderRadius:10, padding:"13px 16px", marginBottom:18, animation:"fadeIn 0.3s ease" }}>
          <div style={{ color:C.purple, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:700, marginBottom:8 }}>◎ Your Requests</div>
          {submitted.map((t,i)=><div key={i} style={{ display:"flex", alignItems:"center", gap:8, color:C.text, fontSize:13, marginBottom:4 }}><span style={{ color:C.success }}>✓</span> {t} <span style={{ color:C.textDim, fontSize:11 }}>— submitted</span></div>)}
        </div>
      )}
      {EMP_INTEGRATIONS.map(cat=>(
        <div key={cat.category} style={{ marginBottom:22 }}>
          <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.09em", fontWeight:700, marginBottom:10, paddingBottom:6, borderBottom:`1px solid ${C.border}` }}>{cat.category}</div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(230px,1fr))", gap:9 }}>
            {cat.tools.map(t=>{
              const isConn=!!connected[t.id], isComing=t.status==="coming";
              return (
                <div key={t.id} style={{ background:C.surface, border:`1px solid ${isConn?C.accent:C.border}`, borderRadius:10, padding:"15px 16px", opacity:isComing?0.7:1, transition:"border-color 0.15s" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:9, marginBottom:8 }}>
                    <span style={{ fontSize:20 }}>{t.icon}</span>
                    <div>
                      <div style={{ color:C.text, fontWeight:700, fontSize:13 }}>{t.name}</div>
                      {isComing&&<span style={{ background:C.warnSoft, color:C.warn, border:`1px solid ${C.warn}44`, borderRadius:4, padding:"1px 6px", fontSize:9, fontWeight:700, textTransform:"uppercase" }}>Coming Soon</span>}
                      {isConn&&<span style={{ background:C.successSoft, color:C.success, border:`1px solid ${C.success}44`, borderRadius:4, padding:"1px 6px", fontSize:9, fontWeight:700, textTransform:"uppercase" }}>Connected</span>}
                    </div>
                  </div>
                  <div style={{ color:C.textDim, fontSize:12, lineHeight:1.6, marginBottom:12 }}>{t.desc}</div>
                  <button onClick={()=>!isComing&&toggle(t.id,t.name)} style={{ width:"100%", background:isComing?C.surfaceHigh:isConn?C.dangerSoft:C.accent, color:isComing?C.textMuted:isConn?C.danger:"#fff", border:isComing?`1px solid ${C.border}`:isConn?`1px solid ${C.danger}44`:"none", borderRadius:7, padding:"7px", fontSize:12, fontWeight:600, cursor:isComing?"not-allowed":"pointer", transition:"all 0.15s" }}>
                    {isComing?"Notify Me":isConn?"Disconnect":"Connect"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div style={{ marginTop:16, background:`linear-gradient(135deg,${C.accent}14,${C.purple}10)`, border:`1px solid ${C.accent}33`, borderRadius:12, padding:"20px 18px", display:"flex", alignItems:"center", gap:16, flexWrap:"wrap" }}>
        <div style={{ flex:1 }}>
          <div style={{ fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:800, fontSize:15, color:C.text, marginBottom:4 }}>Using a tool that's not listed?</div>
          <div style={{ color:C.textDim, fontSize:12, lineHeight:1.6 }}>Clarix connects with your existing stack. Submit a request and we'll scope the integration within 48 hours.</div>
        </div>
        <button onClick={()=>setReqModal(true)} style={{ background:C.accent, color:"#fff", border:"none", borderRadius:9, padding:"10px 20px", fontSize:12, fontWeight:700, cursor:"pointer", flexShrink:0 }}>Request Integration →</button>
      </div>
    </div>
  );
}

function EmployeeScorecard({ onSignOut, dark, setDark, C }) {
  const [tab,setTab]=useState("overview");
  const TABS=[
    { id:"overview",     label:"Overview",     icon:"🏠" },
    { id:"daily",        label:"Daily",        icon:"◉"  },
    { id:"weekly",       label:"Weekly",       icon:"◈"  },
    { id:"monthly",      label:"Monthly",      icon:"◆"  },
    { id:"integrations", label:"Integrations", icon:"⚡" },
  ];
  return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.text, fontFamily:"'Inter',sans-serif", display:"flex", flexDirection:"column" }}>
      <nav style={{ borderBottom:`1px solid ${C.border}`, background:C.surface, padding:"0 16px", height:52, display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0, position:"sticky", top:0, zIndex:100 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:800, fontSize:17, color:C.text }}>CLARIX</span>
          <span style={{ background:C.accentSoft, color:C.accent, border:`1px solid ${C.accent}44`, borderRadius:4, padding:"2px 6px", fontSize:9, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.06em" }}>Beta</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ color:C.textDim, fontSize:12 }}>◉ {EMP_PROFILE.name}</span>
          <button onClick={onSignOut} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:6, padding:"4px 9px", fontSize:11, cursor:"pointer" }}>Sign Out</button>
          <button onClick={()=>setDark(!dark)} style={{ background:C.toggle, border:`1px solid ${C.border}`, borderRadius:20, padding:"5px 11px", fontSize:12, color:C.textDim, cursor:"pointer" }}>{dark?"☀":"☾"}</button>
        </div>
      </nav>
      <div style={{ display:"flex", flex:1 }}>
        <aside style={{ width:196, flexShrink:0, background:C.surface, borderRight:`1px solid ${C.border}`, padding:"14px 9px", height:"calc(100vh - 52px)", position:"sticky", top:52, overflowY:"auto" }}>
          <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:600, marginBottom:8, paddingLeft:3 }}>My Performance</div>
          {TABS.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} style={{ width:"100%", textAlign:"left", background:tab===t.id?C.accentSoft:"transparent", border:`1px solid ${tab===t.id?C.accent:C.border}`, color:tab===t.id?C.accent:C.textDim, borderRadius:7, padding:"7px 10px", fontSize:12, fontWeight:500, cursor:"pointer", marginBottom:4, display:"flex", alignItems:"center", gap:7, transition:"all 0.15s" }}>
              <span style={{ fontSize:12 }}>{t.icon}</span> {t.label}
            </button>
          ))}
          <div style={{ borderTop:`1px solid ${C.border}`, marginTop:12, paddingTop:10 }}>
            <div style={{ background:C.surfaceHigh, border:`1px solid ${C.border}`, borderRadius:8, padding:"10px 12px" }}>
              <div style={{ color:C.textDim, fontSize:9, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:600, marginBottom:6 }}>My Profile</div>
              <div style={{ color:C.text, fontSize:11, fontWeight:600, marginBottom:2 }}>{EMP_PROFILE.name}</div>
              <div style={{ color:C.textDim, fontSize:10 }}>{EMP_PROFILE.dept}</div>
              <div style={{ color:C.textMuted, fontSize:10, marginTop:2 }}>{EMP_PROFILE.id}</div>
            </div>
          </div>
        </aside>
        <main style={{ flex:1, overflowY:"auto", padding:"24px" }}>
          {tab==="overview"     && <EmpOverviewTab C={C}/>}
          {tab==="daily"        && <EmpDailyTab C={C}/>}
          {tab==="weekly"       && <EmpWeeklyTab C={C}/>}
          {tab==="monthly"      && <EmpMonthlyTab C={C}/>}
          {tab==="integrations" && <EmpIntegrationsTab C={C}/>}
        </main>
      </div>
    </div>
  );
}

// ─── LOGIN SCREEN ─────────────────────────────────────────────────────────────
function LoginScreen({ onLogin, dark, setDark, C }) {
  const [selected, setSelected] = useState(null);
  const [password, setPassword] = useState("");
  const [error,    setError]    = useState("");
  const attempt = () => {
    if (!selected) { setError("Please select a role first."); return; }
    if (password === ACCOUNTS[selected].password) { onLogin(selected); }
    else { setError("Incorrect password. Please try again."); setPassword(""); }
  };
  return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.text, fontFamily:"'Inter',sans-serif", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:20 }}>
      <style>{GS}</style>
      <div style={{ width:"100%", maxWidth:380, animation:"fadeIn 0.4s ease" }}>
        <div style={{ textAlign:"center", marginBottom:32 }}>
          <div style={{ fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:800, fontSize:30, color:C.text }}>CLARIX</div>
          <div style={{ color:C.textDim, fontSize:13, marginTop:4 }}>Operational Intelligence Platform</div>
        </div>

        <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:14, padding:24 }}>
          <div style={{ color:C.textDim, fontSize:11, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:600, marginBottom:12 }}>Select your role</div>
          <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:20 }}>
            {Object.entries(ACCOUNTS).map(([id, acc]) => (
              <button key={id} onClick={()=>{ setSelected(id); setError(""); }} style={{ background:selected===id?C.accentSoft:"transparent", border:`1px solid ${selected===id?C.accent:C.border}`, borderRadius:9, padding:"12px 15px", cursor:"pointer", textAlign:"left", display:"flex", alignItems:"center", gap:10, transition:"all 0.15s" }}>
                <span style={{ color:C.accent, fontSize:15 }}>{acc.icon}</span>
                <div>
                  <div style={{ color:C.text, fontWeight:600, fontSize:13 }}>{acc.label}</div>
                  <div style={{ color:C.textDim, fontSize:11 }}>{acc.desc}</div>
                </div>
                {selected===id && <span style={{ marginLeft:"auto", color:C.accent, fontSize:14 }}>✓</span>}
              </button>
            ))}
          </div>

          {selected && (
            <div style={{ animation:"fadeIn 0.2s ease" }}>
              <div style={{ color:C.textDim, fontSize:11, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:600, marginBottom:8 }}>Password</div>
              <input type="password" placeholder="Enter your password" value={password} onChange={e=>{setPassword(e.target.value);setError("");}}
                onKeyDown={e=>e.key==="Enter"&&attempt()}
                style={{ background:C.surfaceHigh, border:`1px solid ${error?C.danger:C.border}`, color:C.text, borderRadius:8, padding:"10px 13px", fontSize:14, width:"100%", fontFamily:"inherit", outline:"none", marginBottom:error?8:16 }}/>
              {error && <div style={{ color:C.danger, fontSize:12, marginBottom:12 }}>{error}</div>}
              <button onClick={attempt} style={{ background:C.accent, color:"#fff", border:"none", borderRadius:8, padding:"11px", fontSize:14, fontWeight:600, cursor:"pointer", width:"100%", transition:"opacity 0.15s" }}
                onMouseEnter={e=>e.target.style.opacity="0.85"} onMouseLeave={e=>e.target.style.opacity="1"}>
                Sign In →
              </button>
            </div>
          )}
        </div>

        <button onClick={()=>setDark(!dark)} style={{ display:"block", margin:"16px auto 0", background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:20, padding:"5px 14px", fontSize:12, cursor:"pointer" }}>{dark?"☀ Light mode":"☾ Dark mode"}</button>
      </div>
    </div>
  );
}

// ─── UPLOAD SCREEN ────────────────────────────────────────────────────────────
function UploadScreen({ role, onBack, onFilesLoaded, onSamples, onMemory, onIntegrations, dark, setDark, memCount, C }) {
  const [drag,         setDrag]         = useState(false);
  const [showReqModal, setShowReqModal] = useState(false);
  const [toast,        setToast]        = useState(null);
  const [xlsxUrl,      setXlsxUrl]      = useState("");
  const [xlsxMode,     setXlsxMode]     = useState(false); // toggle paste URL area
  const [xlsxLoading,  setXlsxLoading]  = useState(false);
  const fileRef = useRef();
  const acc = ACCOUNTS[role];

  const showToast = msg => { setToast(msg); setTimeout(()=>setToast(null), 3500); };
  const handleRequestSubmit = toolName => { setShowReqModal(false); showToast(`"${toolName}" request submitted — we'll prioritise it!`); };

  // Handle Excel/web link: fetch the URL as a blob and parse with PapaParse
  const handleXlsxUrl = async () => {
    const url = xlsxUrl.trim();
    if (!url) return;
    setXlsxLoading(true);
    try {
      // Try to fetch and treat as CSV text (works for Google Sheets export links, public CSVs etc.)
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not fetch file (HTTP ${res.status})`);
      const text = await res.text();
      // Create a fake FileList-like structure by wrapping as a File
      const blob = new Blob([text], { type:"text/csv" });
      // Derive a name from the URL
      const urlName = url.split("/").pop().split("?")[0] || "web_data.csv";
      const file = new File([blob], urlName.endsWith(".csv")?urlName:urlName+".csv", { type:"text/csv" });
      const dt = new DataTransfer();
      dt.items.add(file);
      onFilesLoaded(dt.files);
      setXlsxUrl("");
      setXlsxMode(false);
      showToast("File fetched successfully — mapping columns…");
    } catch(e) {
      showToast(`⚠ Could not load URL: ${e.message}`);
    }
    setXlsxLoading(false);
  };

  return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.text, fontFamily:"'Inter',sans-serif" }}>
      <style>{GS}</style>

      {/* Toast */}
      {toast && (
        <div style={{ position:"fixed", bottom:24, right:24, background:C.accent, color:"#fff", borderRadius:10, padding:"12px 20px", fontSize:13, fontWeight:600, zIndex:9999, animation:"fadeIn 0.25s ease", boxShadow:"0 6px 24px rgba(0,0,0,0.15)" }}>
          ✓ {toast}
        </div>
      )}

      {/* Modal */}
      {showReqModal && <RequestIntegrationModal C={C} onClose={()=>setShowReqModal(false)} onSubmit={toolName=>handleRequestSubmit(toolName)}/>}

      {/* ── SPOT 1: Nav bar — always visible at top ── */}
      <nav style={{ borderBottom:`1px solid ${C.border}`, background:C.surface, padding:"0 20px", height:52, display:"flex", alignItems:"center", justifyContent:"space-between", position:"sticky", top:0, zIndex:100 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <button onClick={onBack} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:7, padding:"5px 12px", fontSize:12, cursor:"pointer", display:"flex", alignItems:"center", gap:5, transition:"all 0.15s" }}
            onMouseEnter={e=>{ e.currentTarget.style.borderColor=C.danger; e.currentTarget.style.color=C.danger; }}
            onMouseLeave={e=>{ e.currentTarget.style.borderColor=C.border; e.currentTarget.style.color=C.textDim; }}>
            Sign Out
          </button>
          <span style={{ fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:800, fontSize:17 }}>CLARIX</span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ color:C.textDim, fontSize:12 }}>{acc.icon} {acc.label}</span>
          <button onClick={()=>setDark(!dark)} style={{ background:C.toggle, border:`1px solid ${C.border}`, borderRadius:20, padding:"5px 11px", fontSize:12, color:C.textDim, cursor:"pointer" }}>{dark?"☀":"☾"}</button>
        </div>
      </nav>

      <div style={{ maxWidth:520, margin:"44px auto", padding:"0 20px", textAlign:"center" }}>
        <h1 style={{ fontFamily:"'DM Serif Display',Georgia,serif", fontSize:26, fontWeight:800, margin:"0 0 10px" }}>Upload your data<br/><span style={{ color:C.accent }}>to get started.</span></h1>
        <p style={{ color:C.textDim, fontSize:14, lineHeight:1.7, margin:"0 0 22px" }}>Upload CSV exports from your call platform, scheduling tool, transport tracker, or document portal. Clarix detects risks and surfaces insights automatically.</p>

        {/* Drop zone */}
        <div onClick={()=>!xlsxMode&&fileRef.current?.click()} onDrop={e=>{e.preventDefault();setDrag(false);onFilesLoaded(e.dataTransfer.files);}} onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)}
          style={{ border:`2px dashed ${drag?C.accent:C.border}`, borderRadius:13, padding:"28px 22px", cursor:xlsxMode?"default":"pointer", background:drag?C.accentSoft:C.surface, transition:"all 0.2s", marginBottom:12 }}>
          <div style={{ fontSize:24, marginBottom:9 }}>📂</div>
          <div style={{ fontWeight:600, fontSize:14, marginBottom:4 }}>Drop CSV files here or click to browse</div>
          <div style={{ color:C.textDim, fontSize:13, marginBottom:12 }}>Call Ops · Transport · Document Processing · Scheduling</div>

          {/* ── Excel / Web link paste area ── */}
          <div onClick={e=>e.stopPropagation()} style={{ borderTop:`1px dashed ${C.border}`, paddingTop:12, marginTop:4 }}>
            {!xlsxMode ? (
              <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:10, flexWrap:"wrap" }}>
                <button onClick={e=>{e.stopPropagation();setXlsxMode(true);}}
                  style={{ background:C.surfaceHigh, border:`1px solid ${C.border}`, color:C.text, borderRadius:7, padding:"6px 14px", fontSize:12, fontWeight:600, cursor:"pointer", display:"flex", alignItems:"center", gap:6, transition:"all 0.15s" }}
                  onMouseEnter={e=>{e.currentTarget.style.borderColor=C.accent;e.currentTarget.style.color=C.accent;}}
                  onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;e.currentTarget.style.color=C.text;}}>
                  🔗 Paste Excel / Web link
                </button>
                <span style={{ color:C.textMuted, fontSize:11 }}>Works with Google Sheets export links & public CSVs</span>
              </div>
            ) : (
              <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                <div style={{ color:C.textDim, fontSize:11, fontWeight:600, textAlign:"left" }}>Paste a public CSV or Google Sheets export URL:</div>
                <div style={{ display:"flex", gap:7 }}>
                  <input
                    autoFocus
                    value={xlsxUrl}
                    onChange={e=>setXlsxUrl(e.target.value)}
                    onKeyDown={e=>e.key==="Enter"&&handleXlsxUrl()}
                    placeholder="https://docs.google.com/spreadsheets/d/.../export?format=csv"
                    style={{ flex:1, background:C.bg, border:`1px solid ${C.accent}66`, color:C.text, borderRadius:7, padding:"7px 11px", fontSize:12, fontFamily:"inherit", outline:"none" }}
                  />
                  <button onClick={handleXlsxUrl} disabled={xlsxLoading||!xlsxUrl.trim()}
                    style={{ background:xlsxUrl.trim()?C.accent:C.surfaceHigh, color:xlsxUrl.trim()?"#fff":C.textMuted, border:"none", borderRadius:7, padding:"7px 14px", fontSize:12, fontWeight:700, cursor:xlsxUrl.trim()?"pointer":"not-allowed", flexShrink:0, transition:"all 0.15s" }}>
                    {xlsxLoading?"…":"Load →"}
                  </button>
                  <button onClick={()=>{setXlsxMode(false);setXlsxUrl("");}}
                    style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:7, padding:"7px 10px", fontSize:12, cursor:"pointer" }}>✕</button>
                </div>
                <div style={{ color:C.textMuted, fontSize:11, textAlign:"left" }}>
                  💡 In Google Sheets: File → Share → Publish to web → CSV → Copy link
                </div>
              </div>
            )}
          </div>

          {/* ── subtle integration nudge ── */}
          <div style={{ marginTop:12, paddingTop:12, borderTop:`1px dashed ${C.border}` }}>
            <span style={{ color:C.textDim, fontSize:12 }}>Using a different platform?{" "}</span>
            <button onClick={e=>{e.stopPropagation();setShowReqModal(true);}} style={{ background:"none", border:"none", color:C.accent, fontSize:12, fontWeight:700, cursor:"pointer", padding:0, textDecoration:"underline" }}>
              Request an integration
            </button>
          </div>
          <input ref={fileRef} type="file" accept=".csv" multiple style={{ display:"none" }} onChange={e=>onFilesLoaded(e.target.files)}/>
        </div>

        {/* Action buttons */}
        <div style={{ display:"flex", gap:8, justifyContent:"center", flexWrap:"wrap", marginBottom:24 }}>
          <button onClick={onSamples} style={{ background:C.accent, color:"#fff", border:"none", borderRadius:8, padding:"9px 18px", fontSize:13, fontWeight:600, cursor:"pointer" }}>Try sample data →</button>
          <button onClick={onMemory} style={{ background:C.purpleSoft, border:`1px solid ${C.purple}44`, color:C.purple, borderRadius:8, padding:"9px 16px", fontSize:13, cursor:"pointer" }}>◎ Memory Layer ({memCount} events)</button>
        </div>

        {/* Feature cards — spot 3 woven into card 05 */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9, textAlign:"left", marginBottom:16 }}>
          {[
            { n:"01", t:"Works with any CSV",    d:"Upload exports from any tool. Clarix detects data type automatically." },
            { n:"02", t:"Early Warning Engine",  d:"20+ rules detect operational risks before they escalate." },
            { n:"03", t:"Memory Layer",          d:"Log decisions, track outcomes, build institutional knowledge." },
            { n:"04", t:"Role-based views",      d:"Director, Team Lead, and Employee each see their own layer." },
          ].map(c=>(
            <div key={c.n} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:9, padding:"12px 13px" }}>
              <div style={{ color:C.accent, fontFamily:"monospace", fontSize:10, marginBottom:3, fontWeight:600 }}>{c.n}</div>
              <div style={{ fontWeight:600, fontSize:13, marginBottom:2 }}>{c.t}</div>
              <div style={{ color:C.textDim, fontSize:12, lineHeight:1.5 }}>{c.d}</div>
            </div>
          ))}
        </div>

        {/* ── SPOT 3: integration card — same grid style, feels native ── */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9, textAlign:"left", marginBottom:28 }}>
          <div style={{ background:C.accentSoft, border:`1px solid ${C.accent}33`, borderRadius:9, padding:"12px 13px" }}>
            <div style={{ color:C.accent, fontFamily:"monospace", fontSize:10, marginBottom:3, fontWeight:600 }}>05</div>
            <div style={{ fontWeight:700, fontSize:13, marginBottom:2, color:C.accent }}>Integrations</div>
            <div style={{ color:C.textDim, fontSize:12, lineHeight:1.5, marginBottom:8 }}>Connect Zendesk, Genesys, Slack, Workday & more — no CSV needed.</div>
            <button onClick={()=>setShowReqModal(true)} style={{ background:C.accent, color:"#fff", border:"none", borderRadius:6, padding:"5px 12px", fontSize:11, fontWeight:700, cursor:"pointer" }}>
              ＋ Request Integration
            </button>
          </div>
          {/* ── SPOT 4: bottom banner — pitch closer ── */}
          <div style={{ background:`linear-gradient(135deg, ${C.purple}14, ${C.accent}10)`, border:`1px solid ${C.purple}33`, borderRadius:9, padding:"12px 13px", display:"flex", flexDirection:"column", justifyContent:"space-between" }}>
            <div>
              <div style={{ color:C.purple, fontFamily:"monospace", fontSize:10, marginBottom:3, fontWeight:600 }}>06</div>
              <div style={{ fontWeight:700, fontSize:13, marginBottom:2, color:C.text }}>Built for your stack</div>
              <div style={{ color:C.textDim, fontSize:12, lineHeight:1.5, marginBottom:8 }}>Already using a workforce tool? We scope integrations in 48 hrs.</div>
            </div>
            <button onClick={()=>setShowReqModal(true)} style={{ background:"transparent", border:`1px solid ${C.purple}55`, color:C.purple, borderRadius:6, padding:"5px 12px", fontSize:11, fontWeight:700, cursor:"pointer", textAlign:"center" }}>
              Tell us what you use →
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

// ─── EARLY WARNING PANEL ──────────────────────────────────────────────────────
function EarlyWarningPanel({ lobs, C, onDeptClick, onBack }) {
  const [expanded, setExpanded] = useState({});
  const [aiText,   setAiText]   = useState({});
  const [aiLoad,   setAiLoad]   = useState({});
  const [aiDone,   setAiDone]   = useState({});
  const [filter,   setFilter]   = useState("ALL");
  const alerts = runEWE(lobs);
  const filtered = filter==="ALL"?alerts:alerts.filter(a=>a.severity===filter);
  const counts = { CRITICAL:alerts.filter(a=>a.severity==="CRITICAL").length, WARNING:alerts.filter(a=>a.severity==="WARNING").length, INFO:alerts.filter(a=>a.severity==="INFO").length };

  const generateAI = async alert => {
    const key = alert.id;
    setAiLoad(p=>({...p,[key]:true})); setAiDone(p=>({...p,[key]:true}));
    try {
      const text = await callAI(
        "You are the AI explanation layer for an operational intelligence platform. A rule engine already detected this alert. Explain root cause, estimate impact, give one action.\nWrite:\nCAUSE: [probable root cause — 2 sentences]\nIMPACT: [business impact estimate — 1 sentence]\n→ ACTION: [single specific recommendation]\nBe specific.",
        `Alert: ${alert.title}\nEvidence: ${alert.evidence}\nDept: ${alert.dept}`
      );
      setAiText(p=>({...p,[key]:text}));
    } catch(e) { setAiText(p=>({...p,[key]:`⚠ ${e.message}`})); }
    setAiLoad(p=>({...p,[key]:false}));
  };

  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:18 }}>
        <BackBtn onClick={onBack} C={C}/>
        <div>
          <h2 style={{ margin:0, fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:700, fontSize:18 }}><span style={{ color:C.danger }}>⚡ Early Warning</span> Engine</h2>
          <div style={{ color:C.textDim, fontSize:12 }}>{alerts.length} alerts across {lobs.length} department{lobs.length!==1?"s":""}</div>
        </div>
      </div>

      <div style={{ display:"flex", gap:9, flexWrap:"wrap", marginBottom:18 }}>
        {[{k:"ALL",label:"All",val:alerts.length,bg:C.surfaceHigh,color:C.text,bord:C.border},{k:"CRITICAL",label:"Critical",val:counts.CRITICAL,bg:C.dangerSoft,color:C.danger,bord:C.danger},{k:"WARNING",label:"Warning",val:counts.WARNING,bg:C.warnSoft,color:C.warn,bord:C.warn},{k:"INFO",label:"Info",val:counts.INFO,bg:C.accentSoft,color:C.accent,bord:C.accent}].map(s=>(
          <button key={s.k} onClick={()=>setFilter(s.k)} style={{ background:filter===s.k?s.bg:"transparent", border:`1px solid ${filter===s.k?s.bord:C.border}`, color:filter===s.k?s.color:C.textDim, borderRadius:9, padding:"10px 16px", cursor:"pointer", flex:"1 1 80px", textAlign:"left", transition:"all 0.15s" }}>
            <div style={{ fontSize:22, fontWeight:800, fontFamily:"monospace", color:filter===s.k?s.color:C.text }}>{s.val}</div>
            <div style={{ fontSize:11, marginTop:2 }}>{s.label}</div>
          </button>
        ))}
      </div>

      {filtered.length===0&&<div style={{ textAlign:"center", padding:"36px 0", color:C.textDim }}><div style={{ fontSize:22, marginBottom:8 }}>✓</div><div style={{ fontSize:14, fontWeight:600, color:C.text, marginBottom:3 }}>No alerts</div><div style={{ fontSize:13 }}>All metrics within acceptable thresholds</div></div>}

      <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
        {filtered.map(alert=>{
          const cc={CRITICAL:["#ef444414","#ef4444","#ef444440"],WARNING:["#f59e0b14","#f59e0b","#f59e0b40"],INFO:["#6366f114","#6366f1","#6366f140"]}[alert.severity]||["#6366f114","#6366f1","#6366f140"];
          const isOpen=expanded[alert.id];
          return (
            <div key={alert.id} style={{ background:C.surface, border:`1px solid ${isOpen?cc[2]:C.border}`, borderRadius:11, overflow:"hidden", transition:"border-color 0.15s" }}>
              <div onClick={()=>setExpanded(p=>({...p,[alert.id]:!p[alert.id]}))} style={{ padding:"13px 15px", cursor:"pointer", display:"flex", alignItems:"flex-start", gap:11 }}>
                <div style={{ width:3, flexShrink:0, alignSelf:"stretch", background:cc[1], borderRadius:2 }}/>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:7, flexWrap:"wrap", marginBottom:4 }}>
                    <span style={{ background:cc[0], color:cc[1], border:`1px solid ${cc[2]}`, borderRadius:5, padding:"2px 8px", fontSize:10, fontWeight:700 }}>{alert.severity}</span>
                    <span style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.06em", fontWeight:600 }}>{alert.type}</span>
                    <span style={{ color:C.textMuted, fontSize:10, marginLeft:"auto" }}>{alert.dept}</span>
                  </div>
                  <div style={{ color:C.text, fontSize:13, fontWeight:600, lineHeight:1.4 }}>{alert.title}</div>
                </div>
                <span style={{ color:C.textDim, fontSize:11, flexShrink:0, marginTop:2 }}>{isOpen?"▲":"▼"}</span>
              </div>
              {isOpen&&(
                <div style={{ padding:"0 15px 15px 29px", borderTop:`1px solid ${C.border}` }}>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9, margin:"12px 0" }}>
                    {[{label:"Evidence",icon:"◉",text:alert.evidence,color:C.text},{label:"Business Impact",icon:"⚠",text:alert.impact,color:C.warn}].map(b=>(
                      <div key={b.label} style={{ background:C.surfaceHigh, border:`1px solid ${C.border}`, borderRadius:8, padding:"11px 13px" }}>
                        <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.07em", fontWeight:600, marginBottom:5 }}>{b.icon} {b.label}</div>
                        <div style={{ color:b.color, fontSize:12, lineHeight:1.65 }}>{b.text}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ background:C.successSoft, border:`1px solid ${C.success}44`, borderRadius:8, padding:"11px 13px", marginBottom:12 }}>
                    <div style={{ color:C.success, fontSize:10, textTransform:"uppercase", letterSpacing:"0.07em", fontWeight:600, marginBottom:5 }}>→ Recommended Intervention</div>
                    <div style={{ color:C.text, fontSize:13, lineHeight:1.65 }}>{alert.intervention}</div>
                  </div>
                  <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                    <span style={{ color:C.textDim, fontSize:11 }}>Confidence: <strong style={{ color:C.text }}>{alert.confidence}%</strong></span>
                    {!aiDone[alert.id]&&!aiLoad[alert.id]&&<button onClick={()=>generateAI(alert)} style={{ marginLeft:"auto", background:C.accent, color:"#fff", border:"none", borderRadius:7, padding:"5px 13px", fontSize:12, fontWeight:600, cursor:"pointer" }}>◈ AI Explanation</button>}
                    {alert.dept!=="Cross-Department"&&<button onClick={()=>onDeptClick(alert.dept)} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:7, padding:"5px 12px", fontSize:12, cursor:"pointer" }}>View Dept →</button>}
                  </div>
                  {aiLoad[alert.id]&&<Spinner C={C}/>}
                  {aiText[alert.id]&&!aiLoad[alert.id]&&<AIResult text={aiText[alert.id]} color={C.accent} label="Root Cause Analysis" C={C}/>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── DIRECTOR LOB DRILLDOWN (rich visualization view for director) ─────────────

// Inline SVG bar chart
function BarChart({ data, valueKey, labelKey, color, target, unit="", maxBars=8, C, height=110 }) {
  if (!data || data.length === 0) return null;
  const items = data.slice(0, maxBars);
  const maxVal = Math.max(...items.map(d => parseFloat(d[valueKey]||0)), target||0) * 1.15 || 1;
  return (
    <div style={{ width:"100%", overflowX:"auto" }}>
      <svg width="100%" viewBox={`0 0 ${items.length*56+20} ${height+40}`} style={{ display:"block" }}>
        {/* Target line */}
        {target != null && (
          <>
            <line x1="0" y1={height - (target/maxVal)*height} x2={items.length*56+20} y2={height - (target/maxVal)*height}
              stroke={C.warn} strokeWidth="1" strokeDasharray="4,3" opacity="0.7"/>
            <text x={items.length*56+4} y={height - (target/maxVal)*height - 3} fill={C.warn} fontSize="8" textAnchor="end">target</text>
          </>
        )}
        {items.map((d, i) => {
          const val = parseFloat(d[valueKey]||0);
          const barH = Math.max((val/maxVal)*height, 2);
          const x = i*56 + 8;
          const isOver = target != null && val > target;
          const barColor = isOver ? C.danger : color;
          return (
            <g key={i}>
              <rect x={x} y={height-barH} width={40} height={barH} fill={barColor} opacity="0.85" rx="3"/>
              <text x={x+20} y={height-barH-4} textAnchor="middle" fill={barColor} fontSize="9" fontFamily="monospace" fontWeight="700">
                {val}{unit}
              </text>
              <text x={x+20} y={height+12} textAnchor="middle" fill={C.textDim} fontSize="8">
                {String(d[labelKey]||"").slice(0,7)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Inline SVG line/area sparkline for trend
function TrendChart({ data, valueKey, labelKey, color, target, unit="", C, height=80 }) {
  if (!data || data.length < 2) return null;
  const vals = data.map(d => parseFloat(d[valueKey]||0));
  const labels = data.map(d => d[labelKey]||"");
  const maxVal = Math.max(...vals, target||0) * 1.1 || 1;
  const minVal = Math.min(...vals) * 0.9;
  const w = 320, pad = 24;
  const pts = vals.map((v,i) => {
    const x = pad + (i/(vals.length-1))*(w-pad*2);
    const y = height - ((v-minVal)/(maxVal-minVal||1))*(height-20)-4;
    return `${x},${y}`;
  }).join(" ");
  const areaBottom = `${pad + (vals.length-1)/(vals.length-1)*(w-pad*2)},${height} ${pad},${height}`;
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${height+20}`} style={{ display:"block", overflow:"visible" }}>
      {target != null && (
        <line x1={pad} y1={height - ((target-minVal)/(maxVal-minVal||1))*(height-20)-4}
              x2={w-pad} y2={height - ((target-minVal)/(maxVal-minVal||1))*(height-20)-4}
              stroke={C.warn} strokeWidth="1" strokeDasharray="4,3" opacity="0.6"/>
      )}
      <polyline fill={`${color}22`} stroke="none" points={`${pts} ${areaBottom}`}/>
      <polyline fill="none" stroke={color} strokeWidth="2" points={pts} strokeLinecap="round" strokeLinejoin="round"/>
      {vals.map((v,i) => {
        const x = pad + (i/(vals.length-1))*(w-pad*2);
        const y = height - ((v-minVal)/(maxVal-minVal||1))*(height-20)-4;
        return <circle key={i} cx={x} cy={y} r="3" fill={color}/>;
      })}
      {labels.map((l,i) => {
        const x = pad + (i/(vals.length-1))*(w-pad*2);
        return <text key={i} x={x} y={height+14} textAnchor="middle" fill={C.textDim} fontSize="8">{l}</text>;
      })}
    </svg>
  );
}

// Horizontal gauge bar
function GaugeBar({ value, max=100, color, label, target, unit="%", C }) {
  const pct = Math.min((parseFloat(value)||0)/max*100, 100);
  const tPct = target ? Math.min(target/max*100, 100) : null;
  return (
    <div style={{ marginBottom:10 }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:4 }}>
        <span style={{ color:C.text, fontSize:12, fontWeight:600 }}>{label}</span>
        <span style={{ color, fontFamily:"monospace", fontSize:13, fontWeight:700 }}>{value}{unit}</span>
      </div>
      <div style={{ background:C.surfaceHigh, borderRadius:6, height:10, position:"relative", overflow:"visible" }}>
        <div style={{ width:`${pct}%`, height:"100%", background:color, borderRadius:6, transition:"width 0.6s ease" }}/>
        {tPct != null && (
          <div style={{ position:"absolute", left:`${tPct}%`, top:-3, width:2, height:16, background:C.warn, borderRadius:1 }}/>
        )}
      </div>
      {target && <div style={{ color:C.textMuted, fontSize:9, marginTop:2 }}>Target: {target}{unit}</div>}
    </div>
  );
}

// Donut / ring chart for split metrics
function DonutChart({ value, total, color, label, C, size=80 }) {
  const pct = total > 0 ? (value/total) : 0;
  const r = 28, cx = size/2, cy = size/2;
  const circ = 2*Math.PI*r;
  const dash = pct * circ;
  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:4 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={C.surfaceHigh} strokeWidth="7"/>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="7"
          strokeDasharray={`${dash} ${circ-dash}`} strokeLinecap="round"
          transform={`rotate(-90 ${cx} ${cy})`} opacity="0.9"/>
        <text x={cx} y={cy+1} textAnchor="middle" dominantBaseline="middle" fill={color} fontSize="11" fontWeight="800" fontFamily="monospace">
          {Math.round(pct*100)}%
        </text>
      </svg>
      <div style={{ color:C.textDim, fontSize:10, textAlign:"center", lineHeight:1.3 }}>{label}</div>
    </div>
  );
}

function DirectorLOBView({ lob, color, C, onBack }) {
  const [rcaText,  setRcaText]  = useState(null);
  const [rcaLoad,  setRcaLoad]  = useState(false);
  const [rcaDone,  setRcaDone]  = useState(false);
  const [tab,      setTab]      = useState("overview"); // overview | agents | data

  const m = computeMetrics(lob.data, lob.name, lob.mapping, lob.lobType);
  const agentKey = lob.data.length > 0
    ? Object.keys(lob.data[0]).find(k=>["agent","employee","name"].includes(k.toLowerCase())) || Object.keys(lob.data[0])[0]
    : "Agent";

  // Build per-date aggregates for trend chart (if date column exists)
  const dateKey = Object.keys(lob.data[0]||{}).find(k=>k.toLowerCase().includes("date"));
  const agentGroups = {};
  lob.data.forEach(r => { const a=r[agentKey]||"Unknown"; if(!agentGroups[a])agentGroups[a]=[]; agentGroups[a].push(r); });
  const agentNames = Object.keys(agentGroups);

  // Build RCA prompt for director
  const runRCA = async () => {
    setRcaLoad(true); setRcaDone(true);
    try {
      const deptType = m._type==="call"?"CALL OPERATIONS":m._type==="transport"?"TRANSPORT & ATTENDANCE":m._type==="docs"?"DOCUMENT PROCESSING":m._type==="scheduling"?"WORKFORCE SCHEDULING":lob.name.toUpperCase();
      const metricSummary = m._type==="call"
        ? `Drop Rate: ${m._drop_rate}% | CSAT: ${m._csat}/5.0 | AHT: ${m._aht_min}min | FCR: ${m._fcr||"N/A"}%`
        : m._type==="transport"
        ? `No-Show Rate: ${m._no_show_rate}% | No-Shows: ${m._no_shows}/${lob.data.length} | At-Risk: ${(m._at_risk||[]).join(", ")||"None"}`
        : m._type==="docs"
        ? `Rejection Rate: ${m._avg_rejection}% | Process Time: ${m._avg_process}min | Rejected: ${m._total_rejected}`
        : m._type==="scheduling"
        ? `Adherence: ${m._adherence}% | Late Logins: ${m._late_count} | Risk: ${m._risk}`
        : "See agent breakdown.";
      const agentLines = (m._agents||m._top_rejectors||m._low_adherence||m._transport_agents||[])
        .slice(0,8).map(a=>JSON.stringify(a)).join("\n");
      const text = await callAI(
        `You are briefing an EXECUTIVE DIRECTOR on ${deptType}. Be strategic, reference exact numbers, name specific agents.\n\nFormat EXACTLY:\nROOT CAUSE: [Primary cause — 2 sentences with numbers]\nCONTRIBUTING FACTORS:\n• [Factor 1 — specific agent/metric]\n• [Factor 2 — specific agent/metric]\n• [Factor 3 — specific agent/metric]\n⚠ HIGHEST RISK: [Most urgent issue with exact metric]\n→ IMMEDIATE ACTION: [Director-level action within 24h]\n→ 30-DAY PLAN: [Structural fix specific to this dept]`,
        `DEPT: ${lob.name} (${deptType})\nRISK: ${m._risk}\nRECORDS: ${lob.data.length}\nMETRICS:\n${metricSummary}\nAGENT BREAKDOWN:\n${agentLines}`,
        900
      );
      setRcaText(text);
    } catch(e) { setRcaText(`⚠ ${e.message}`); }
    setRcaLoad(false);
  };

  // ── Chart data builders per LOB type ──────────────────────────────────────
  const renderCharts = () => {
    if (m._type === "call") {
      const agents = m._agents || [];
      return (
        <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
          {/* KPI row */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))", gap:10 }}>
            {[
              { label:"Drop Rate",    val:`${m._drop_rate}%`, sub:"target <7%",      color:parseFloat(m._drop_rate)>7?C.danger:C.success },
              { label:"Avg CSAT",     val:m._csat,             sub:"out of 5.0",      color:parseFloat(m._csat)<4?C.warn:C.success },
              { label:"Avg AHT",      val:`${m._aht_min}m`,    sub:"handle time",     color:color },
              { label:"FCR",          val:m._fcr?`${m._fcr}%`:"—", sub:"1st contact", color:color },
              { label:"Total Calls",  val:agents.reduce((a,x)=>a+x.calls,0), sub:"answered", color:color },
              { label:"Total Drops",  val:agents.reduce((a,x)=>a+x.dropped,0), sub:"dropped", color:C.danger },
            ].map(s=>s.val!==null&&s.val!==undefined&&<StatCard key={s.label} label={s.label} value={s.val} sub={s.sub} color={s.color} C={C}/>)}
          </div>

          {/* Agent CSAT bar chart */}
          {agents.length > 0 && (
            <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:"16px 18px" }}>
              <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:700, marginBottom:4 }}>Agent CSAT Scores</div>
              <div style={{ color:C.textMuted, fontSize:11, marginBottom:12 }}>Target: 4.0 / 5.0 — bars above target shown in green, below in red</div>
              <BarChart data={agents} valueKey="csat" labelKey="name" color={C.success} target={4.0} unit="" C={C}/>
            </div>
          )}

          {/* Drop rate gauges per agent */}
          {agents.length > 0 && (
            <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:"16px 18px" }}>
              <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:700, marginBottom:12 }}>Individual Drop Rates</div>
              {agents.map(a => {
                const rate = a.calls+a.dropped > 0 ? ((a.dropped/(a.calls+a.dropped))*100).toFixed(1) : "0";
                return <GaugeBar key={a.name} label={a.name} value={rate} max={30} color={parseFloat(rate)>10?C.danger:parseFloat(rate)>5?C.warn:C.success} target={7} unit="%" C={C}/>;
              })}
            </div>
          )}

          {/* Calls answered vs dropped donut split */}
          {agents.length > 0 && (
            <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:"16px 18px" }}>
              <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:700, marginBottom:14 }}>Call Outcomes by Agent</div>
              <div style={{ display:"flex", gap:16, flexWrap:"wrap" }}>
                {agents.map(a=>(
                  <DonutChart key={a.name} value={a.dropped} total={a.calls+a.dropped} color={C.danger} label={`${a.name}\ndrops`} C={C}/>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }

    if (m._type === "transport") {
      const agents = m._transport_agents || [];
      const atRisk = m._at_risk || [];
      const noShowPct = parseFloat(m._no_show_rate||0);
      return (
        <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))", gap:10 }}>
            {[
              { label:"No-Show Rate", val:`${m._no_show_rate}%`, sub:"target <10%",   color:noShowPct>15?C.danger:noShowPct>8?C.warn:C.success },
              { label:"No-Shows",     val:m._no_shows,            sub:"total incidents",color:C.danger },
              { label:"At-Risk",      val:atRisk.length,           sub:"2+ absences",  color:atRisk.length>0?C.warn:C.success },
              { label:"Present",      val:lob.data.length-m._no_shows, sub:"boarded",  color:C.success },
            ].map(s=><StatCard key={s.label} label={s.label} value={s.val} sub={s.sub} color={s.color} C={C}/>)}
          </div>

          {/* No-show vs present donut */}
          <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:"16px 18px", display:"flex", gap:24, alignItems:"center", flexWrap:"wrap" }}>
            <DonutChart value={m._no_shows} total={lob.data.length} color={C.danger} label="No-Show Rate" C={C} size={100}/>
            <div style={{ flex:1, minWidth:160 }}>
              <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:700, marginBottom:8 }}>Fleet Attendance Summary</div>
              <GaugeBar label="Present (Boarded)" value={lob.data.length-m._no_shows} max={lob.data.length} color={C.success} unit="" target={null} C={C}/>
              <GaugeBar label="No-Shows" value={m._no_shows} max={lob.data.length} color={C.danger} unit="" target={null} C={C}/>
              {atRisk.length>0&&<div style={{ background:C.dangerSoft, border:`1px solid ${C.danger}44`, borderRadius:8, padding:"8px 12px", marginTop:8 }}>
                <div style={{ color:C.danger, fontSize:10, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:4 }}>⚠ At-Risk Employees</div>
                <div style={{ color:C.text, fontSize:12 }}>{atRisk.join(" · ")}</div>
              </div>}
            </div>
          </div>

          {/* No-shows by agent bar chart */}
          {agents.length > 0 && (
            <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:"16px 18px" }}>
              <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:700, marginBottom:12 }}>No-Shows by Employee</div>
              <BarChart data={agents} valueKey="noShows" labelKey="name" color={C.warn} target={0} unit="" C={C}/>
            </div>
          )}

          {/* Monthly absence trend per employee */}
          {agents.length > 0 && (
            <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:"16px 18px" }}>
              <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:700, marginBottom:12 }}>Monthly Absence Count by Employee</div>
              <BarChart data={agents} valueKey="monthlyNs" labelKey="name" color={C.danger} target={2} unit="" C={C}/>
            </div>
          )}
        </div>
      );
    }

    if (m._type === "docs") {
      const agents = m._top_rejectors || [];
      const avgRej = parseFloat(m._avg_rejection||0);
      return (
        <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))", gap:10 }}>
            {[
              { label:"Avg Rejection",  val:`${m._avg_rejection}%`, sub:"target <8%",       color:avgRej>12?C.danger:avgRej>7?C.warn:C.success },
              { label:"Avg Proc. Time", val:`${m._avg_process}m`,   sub:"per document",     color:color },
              { label:"Total Rejected", val:m._total_rejected,       sub:"docs rejected",   color:C.danger },
              { label:"Total Processed",val:m._total_processed,      sub:"docs processed",  color:C.success },
            ].map(s=>s.val!=null&&<StatCard key={s.label} label={s.label} value={s.val} sub={s.sub} color={s.color} C={C}/>)}
          </div>

          {/* Approval vs rejection donut */}
          <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:"16px 18px", display:"flex", gap:24, alignItems:"center", flexWrap:"wrap" }}>
            <DonutChart value={m._total_rejected} total={(m._total_processed||0)+(m._total_rejected||0)} color={C.danger} label="Rejection Rate" C={C} size={100}/>
            <div style={{ flex:1, minWidth:160 }}>
              <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:700, marginBottom:8 }}>Document Outcomes</div>
              <GaugeBar label="Approved" value={m._total_processed} max={(m._total_processed||0)+(m._total_rejected||0)} color={C.success} unit="" C={C}/>
              <GaugeBar label="Rejected" value={m._total_rejected} max={(m._total_processed||0)+(m._total_rejected||0)} color={C.danger} unit="" C={C}/>
            </div>
          </div>

          {/* Rejection rate by agent */}
          {agents.length > 0 && (
            <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:"16px 18px" }}>
              <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:700, marginBottom:4 }}>Rejection Rate by Agent (%)</div>
              <div style={{ color:C.textMuted, fontSize:11, marginBottom:12 }}>Target: 8% — bars above target shown in red</div>
              <BarChart data={agents} valueKey="rate" labelKey="name" color={C.success} target={8} unit="%" C={C}/>
            </div>
          )}

          {/* Processing time gauges */}
          {agents.length > 0 && (
            <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:"16px 18px" }}>
              <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:700, marginBottom:12 }}>Avg Processing Time by Agent</div>
              {agents.map(a => (
                <GaugeBar key={a.name} label={a.name} value={a.time} max={12} color={parseFloat(a.time)>6?C.warn:C.success} target={5} unit="m" C={C}/>
              ))}
            </div>
          )}
        </div>
      );
    }

    if (m._type === "scheduling") {
      const agents = m._low_adherence || [];
      const avgAdh = parseFloat(m._adherence||0);
      return (
        <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))", gap:10 }}>
            {[
              { label:"Avg Adherence", val:`${m._adherence}%`, sub:"target >90%",  color:avgAdh<80?C.danger:avgAdh<90?C.warn:C.success },
              { label:"Late Logins",   val:m._late_count,       sub:"instances",   color:m._late_count>3?C.danger:C.warn },
              { label:"Risk Level",    val:m._risk,             sub:"overall",     color:m._risk==="HIGH"?C.danger:m._risk==="MEDIUM"?C.warn:C.success },
              { label:"Total Staff",   val:Object.keys(agentGroups).length, sub:"agents tracked", color:color },
            ].map(s=>s.val!=null&&<StatCard key={s.label} label={s.label} value={s.val} sub={s.sub} color={s.color} C={C}/>)}
          </div>

          {/* Adherence gauge per agent */}
          {agents.length > 0 && (
            <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:"16px 18px" }}>
              <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:700, marginBottom:12 }}>Schedule Adherence by Agent</div>
              {agents.map(a => (
                <GaugeBar key={a.name} label={a.name} value={a.adherence} max={100} color={parseFloat(a.adherence)<80?C.danger:parseFloat(a.adherence)<90?C.warn:C.success} target={90} unit="%" C={C}/>
              ))}
            </div>
          )}

          {/* Adherence bar chart */}
          {agents.length > 0 && (
            <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:"16px 18px" }}>
              <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:700, marginBottom:4 }}>Adherence Scores</div>
              <div style={{ color:C.textMuted, fontSize:11, marginBottom:12 }}>Target: 90% — bars below shown in amber/red</div>
              <BarChart data={agents} valueKey="adherence" labelKey="name" color={C.success} target={90} unit="%" C={C} height={100}/>
            </div>
          )}

          {/* Late logins + break violations */}
          {agents.length > 0 && (
            <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:"16px 18px" }}>
              <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:700, marginBottom:12 }}>Late Logins & Break Violations</div>
              <div style={{ display:"flex", gap:12, flexWrap:"wrap" }}>
                {agents.map(a=>(
                  <div key={a.name} style={{ background:C.surfaceHigh, borderRadius:9, padding:"10px 14px", flex:"1 1 100px", minWidth:90 }}>
                    <div style={{ color:C.textDim, fontSize:10, marginBottom:4, fontWeight:600 }}>{a.name}</div>
                    <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                      <div style={{ textAlign:"center" }}>
                        <div style={{ color:a.late>0?C.warn:C.textDim, fontFamily:"monospace", fontWeight:800, fontSize:18 }}>{a.late}</div>
                        <div style={{ color:C.textMuted, fontSize:9 }}>Late</div>
                      </div>
                      <div style={{ width:1, height:28, background:C.border }}/>
                      <div style={{ textAlign:"center" }}>
                        <div style={{ color:a.bv>0?C.danger:C.textDim, fontFamily:"monospace", fontWeight:800, fontSize:18 }}>{a.bv||0}</div>
                        <div style={{ color:C.textMuted, fontSize:9 }}>Break viol.</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }

    // Generic fallback for unmapped data
    const numericCols = Object.keys(lob.data[0]||{}).filter(k => {
      const vals = lob.data.slice(0,10).map(r=>parseFloat(String(r[k]).replace(/[,$%]/g,"")));
      return vals.filter(v=>!isNaN(v)).length >= 5;
    }).slice(0, 4);

    return (
      <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
        <div style={{ background:C.warnSoft, border:`1px solid ${C.warn}44`, borderRadius:9, padding:"10px 14px", color:C.warn, fontSize:12 }}>
          ⚠ Data type auto-detected as unknown. Showing generic column analysis. Use the Column Mapping panel to set the correct department type for richer charts.
        </div>
        {numericCols.map(col => {
          const agentData = agentNames.map(a => ({
            name: a,
            [col]: (agentGroups[a].reduce((sum,r)=>sum+parseFloat(String(r[col]).replace(/[,$%]/g,"")||"0"),0)/agentGroups[a].length).toFixed(1)
          }));
          return (
            <div key={col} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:12, padding:"16px 18px" }}>
              <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", fontWeight:700, marginBottom:12 }}>{col} — Avg by Agent</div>
              <BarChart data={agentData} valueKey={col} labelKey="name" color={color} C={C}/>
            </div>
          );
        })}
      </div>
    );
  };

  const TABS = [
    { id:"overview", label:"Charts & KPIs",   icon:"◈" },
    { id:"agents",   label:"Agent Table",     icon:"◉" },
    { id:"data",     label:"Raw Data",        icon:"⊞" },
  ];

  return (
    <div style={{ animation:"fadeIn 0.25s ease" }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16, flexWrap:"wrap" }}>
        <BackBtn onClick={onBack} C={C}/>
        <div style={{ flex:1 }}>
          <h2 style={{ margin:0, fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:700, fontSize:18 }}>
            <span style={{ color }}>◈ {lob.name}</span>
          </h2>
          <div style={{ color:C.textDim, fontSize:12 }}>{lob.data.length} records · {Object.keys(lob.data[0]||{}).length} columns · Director view</div>
        </div>
        <RiskBadge level={m._risk} C={C}/>
      </div>

      {m._risk==="HIGH"&&<div style={{ background:C.dangerSoft, border:`1px solid ${C.danger}44`, borderRadius:9, padding:"10px 14px", marginBottom:14, color:C.danger, fontSize:13, fontWeight:600 }}>🚨 High risk — requires immediate attention</div>}
      <DataCleaningReport issues={lob.cleaningIssues} C={C}/>

      {/* Tab switcher */}
      <div style={{ display:"flex", gap:6, marginBottom:20, background:C.surfaceHigh, borderRadius:10, padding:4, width:"fit-content" }}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{ background:tab===t.id?C.surface:"transparent", border:`1px solid ${tab===t.id?C.border:"transparent"}`, color:tab===t.id?C.text:C.textDim, borderRadius:7, padding:"6px 14px", fontSize:12, fontWeight:tab===t.id?600:400, cursor:"pointer", display:"flex", alignItems:"center", gap:5, transition:"all 0.15s", boxShadow:tab===t.id?"0 1px 4px rgba(0,0,0,0.08)":"none" }}>
            <span>{t.icon}</span>{t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab==="overview" && (
        <div style={{ animation:"fadeIn 0.2s ease" }}>
          {renderCharts()}

          {/* AI Root Cause Analysis */}
          <div style={{ marginTop:20 }}>
            {rcaLoad && <Spinner C={C} label="Generating Director Root Cause Analysis…"/>}
            {rcaText && !rcaLoad && <AIResult text={rcaText} color={color} label={`${lob.name} · Director Root Cause Analysis`} C={C}/>}
            {!rcaDone && !rcaLoad && (
              <button onClick={runRCA} style={{ background:color, color:"#fff", border:"none", borderRadius:8, padding:"10px 20px", fontSize:13, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", gap:7 }}>
                ◈ AI Intelligence — Root Cause Analysis
              </button>
            )}
            {rcaDone && !rcaLoad && (
              <button onClick={()=>{setRcaText(null);setRcaDone(false);}} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:7, padding:"6px 14px", fontSize:12, cursor:"pointer", marginTop:6 }}>↺ Re-run Analysis</button>
            )}
          </div>
        </div>
      )}

      {tab==="agents" && (
        <div style={{ animation:"fadeIn 0.2s ease" }}>
          {m._agents&&<div style={{ marginBottom:18 }}><div style={{ color:C.textDim, fontSize:11, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:8, fontWeight:600 }}>Agent Performance Table</div><MiniTable rows={m._agents} headers={["name","calls","dropped","csat","aht"]} C={C}/></div>}
          {m._top_rejectors&&<div style={{ marginBottom:18 }}><div style={{ color:C.textDim, fontSize:11, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:8, fontWeight:600 }}>Document Rejection by Agent</div><MiniTable rows={m._top_rejectors} headers={["name","rate","time","rejected"]} C={C}/></div>}
          {m._low_adherence&&<div style={{ marginBottom:18 }}><div style={{ color:C.textDim, fontSize:11, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:8, fontWeight:600 }}>Schedule Adherence by Agent</div><MiniTable rows={m._low_adherence} headers={["name","adherence","late","bv"]} C={C}/></div>}
          {m._transport_agents&&<div style={{ marginBottom:18 }}><div style={{ color:C.textDim, fontSize:11, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:8, fontWeight:600 }}>Attendance by Employee</div><MiniTable rows={m._transport_agents} headers={["name","noShows","monthlyNs"]} C={C}/></div>}
          {m._at_risk&&m._at_risk.length>0&&<div style={{ background:C.dangerSoft, border:`1px solid ${C.danger}44`, borderRadius:9, padding:"11px 14px", marginBottom:14 }}><div style={{ color:C.danger, fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>⚠ Incentive At Risk</div><div style={{ color:C.text, fontSize:13 }}>{m._at_risk.join(", ")} — 2+ absences this month.</div></div>}
          {!m._agents&&!m._top_rejectors&&!m._low_adherence&&!m._transport_agents&&(
            <div style={{ color:C.textDim, fontSize:13, padding:"20px 0" }}>Agent breakdown not available — column mapping may be needed for this data type.</div>
          )}
        </div>
      )}

      {tab==="data" && (
        <div style={{ animation:"fadeIn 0.2s ease" }}>
          <div style={{ color:C.textDim, fontSize:11, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:8, fontWeight:600 }}>Full Source Data — {lob.data.length} rows</div>
          <RawTable data={lob.data} C={C}/>
        </div>
      )}
    </div>
  );
}

// ─── DIRECTOR OVERVIEW ────────────────────────────────────────────────────────
function Overview({ lobs, C, onBack }) {
  const [summary,    setSummary]    = useState(null);
  const [loading,    setLoading]    = useState(false);
  const [done,       setDone]       = useState(false);
  const [activeLob,  setActiveLob]  = useState(null); // name of clicked LOB
  const allM = lobs.map(l=>({name:l.name,m:computeMetrics(l.data,l.name,l.mapping,l.lobType),rows:l.data.length}));
  const highRisk = allM.filter(x=>x.m._risk==="HIGH");
  const medRisk  = allM.filter(x=>x.m._risk==="MEDIUM");

  // If a dept card was clicked, show the director drilldown
  if (activeLob) {
    const lob = lobs.find(l=>l.name===activeLob);
    const lobIdx = lobs.findIndex(l=>l.name===activeLob);
    const color = LOB_COLORS[lobIdx%LOB_COLORS.length];
    if (lob) return <DirectorLOBView lob={lob} color={color} C={C} onBack={()=>setActiveLob(null)}/>;
  }

  const generate = async () => {
    setLoading(true); setDone(true);
    try {
      const combined = lobs.map(l=>{
        const lm = computeMetrics(l.data, l.name, l.mapping, l.lobType);
        const metricSummary = lm._type==="call"
          ? `Drop Rate: ${lm._drop_rate}%, CSAT: ${lm._csat}, AHT: ${lm._aht_min}min`
          : lm._type==="transport"
          ? `No-Show Rate: ${lm._no_show_rate}%, No-Shows: ${lm._no_shows}`
          : lm._type==="docs"
          ? `Rejection Rate: ${lm._avg_rejection}%, Process Time: ${lm._avg_process}min`
          : lm._type==="scheduling"
          ? `Adherence: ${lm._adherence}%, Late Logins: ${lm._late_count}`
          : l.csvText.split("\n").slice(0,4).join("\n");
        return `=== ${l.name} [Risk: ${lm._risk||"?"}, Records: ${l.data.length}] ===\n${metricSummary}`;
      }).join("\n\n");
      const text = await callAI(
        "Cross-department leadership briefing.\nHEADLINE: [one sentence + critical number]\nOne line per dept: [Dept]: [key metric + risk status]\n⚠ TOP RISK: [specific with numbers]\n✓ TOP WIN: [specific with numbers]\n→ PRIORITY: [one action for leadership today]\nSpecific. Reference departments by name.",
        combined, 1000
      );
      setSummary(text);
    } catch(e) { setSummary(`⚠ ${e.message}`); }
    setLoading(false);
  };

  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:18 }}>
        <BackBtn onClick={onBack} C={C}/>
        <div>
          <h2 style={{ margin:0, fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:700, fontSize:18 }}><span style={{ color:C.accent }}>Director</span> Overview</h2>
          <div style={{ color:C.textDim, fontSize:12 }}>Cross-department intelligence · {lobs.length} sources</div>
        </div>
      </div>
      <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginBottom:20 }}>
        {[{label:"High Risk",val:highRisk.length,sub:highRisk.map(x=>x.name).join(", ")||"None",bg:C.dangerSoft,color:C.danger,bord:C.danger},{label:"Medium Risk",val:medRisk.length,sub:medRisk.map(x=>x.name).join(", ")||"None",bg:C.warnSoft,color:C.warn,bord:C.warn},{label:"Depts Online",val:lobs.length,sub:"Data sources",bg:C.successSoft,color:C.success,bord:C.success},{label:"Total Records",val:lobs.reduce((a,l)=>a+l.data.length,0),sub:"All depts",bg:C.surfaceHigh,color:C.text,bord:C.border}].map(s=>(
          <div key={s.label} style={{ background:s.bg, border:`1px solid ${s.bord}44`, borderRadius:10, padding:"13px 16px", flex:"1 1 120px" }}>
            <div style={{ color:s.color, fontSize:10, textTransform:"uppercase", letterSpacing:"0.07em", fontWeight:700, marginBottom:4 }}>{s.label}</div>
            <div style={{ color:s.color, fontSize:26, fontWeight:800, fontFamily:"monospace" }}>{s.val}</div>
            <div style={{ color:C.textDim, fontSize:11, marginTop:2 }}>{s.sub}</div>
          </div>
        ))}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(175px,1fr))", gap:9, marginBottom:20 }}>
        {allM.map((x,i)=>(
          <button key={x.name} onClick={()=>setActiveLob(x.name)}
            style={{ background:C.surfaceHigh, border:`1px solid ${LOB_COLORS[i%LOB_COLORS.length]}33`, borderRadius:10, padding:"12px 14px", cursor:"pointer", textAlign:"left", transition:"all 0.15s" }}
            onMouseEnter={e=>{e.currentTarget.style.borderColor=LOB_COLORS[i%LOB_COLORS.length];e.currentTarget.style.background=`${LOB_COLORS[i%LOB_COLORS.length]}11`;}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor=`${LOB_COLORS[i%LOB_COLORS.length]}33`;e.currentTarget.style.background=C.surfaceHigh;}}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
              <div style={{ color:LOB_COLORS[i%LOB_COLORS.length], fontSize:11, fontWeight:700, textTransform:"uppercase", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>{x.name}</div>
              <RiskBadge level={x.m._risk} C={C}/>
            </div>
            <div style={{ color:C.textDim, fontSize:11, marginBottom:6 }}>{x.rows} records</div>
            <div style={{ color:LOB_COLORS[i%LOB_COLORS.length], fontSize:10, fontWeight:600, display:"flex", alignItems:"center", gap:4 }}>
              View Details <span style={{ fontSize:9 }}>→</span>
            </div>
          </button>
        ))}
      </div>
      {loading && <Spinner C={C} label="Generating cross-department briefing..."/>}
      {summary && !loading && <AIResult text={summary} color={C.accent} label="All Departments" C={C}/>}
      {!done && !loading && <button onClick={generate} style={{ background:C.accent, color:"#fff", border:"none", borderRadius:8, padding:"10px 20px", fontSize:13, fontWeight:600, cursor:"pointer" }}>Generate Cross-Department Briefing</button>}
    </div>
  );
}

// ─── DATA CLEANING REPORT BADGE ──────────────────────────────────────────────
function DataCleaningReport({ issues, C }) {
  const [open, setOpen] = useState(false);
  if (!issues || issues.length === 0) return (
    <div style={{ display:"inline-flex", alignItems:"center", gap:5, background:C.successSoft, border:`1px solid ${C.success}44`, borderRadius:7, padding:"4px 10px", fontSize:11, color:C.success, marginBottom:12 }}>
      ✓ Data clean — no issues detected
    </div>
  );

  const warnings  = issues.filter(i => i.startsWith("⚠"));
  const fixes     = issues.filter(i => !i.startsWith("⚠"));
  const hasWarns  = warnings.length > 0;

  return (
    <div style={{ marginBottom:14 }}>
      <button onClick={()=>setOpen(o=>!o)} style={{ background:hasWarns?C.warnSoft:C.accentSoft, border:`1px solid ${hasWarns?C.warn:C.accent}44`, borderRadius:7, padding:"5px 12px", fontSize:11, fontWeight:600, cursor:"pointer", color:hasWarns?C.warn:C.accent, display:"flex", alignItems:"center", gap:7 }}>
        {hasWarns ? "⚠" : "✓"} Data Auto-Cleaned — {fixes.length} fix{fixes.length!==1?"es":""}{warnings.length>0?`, ${warnings.length} warning${warnings.length!==1?"s":""}`:""} {open?"▲":"▼"}
      </button>
      {open && (
        <div style={{ background:C.surfaceHigh, border:`1px solid ${C.border}`, borderRadius:9, padding:"11px 14px", marginTop:6, animation:"fadeIn 0.2s ease" }}>
          {fixes.length > 0 && (
            <>
              <div style={{ color:C.success, fontSize:10, textTransform:"uppercase", letterSpacing:"0.07em", fontWeight:700, marginBottom:7 }}>✓ Auto-Fixes Applied</div>
              {fixes.map((issue,i) => (
                <div key={i} style={{ color:C.text, fontSize:12, lineHeight:1.7, paddingLeft:8 }}>• {issue}</div>
              ))}
            </>
          )}
          {warnings.length > 0 && (
            <>
              <div style={{ color:C.warn, fontSize:10, textTransform:"uppercase", letterSpacing:"0.07em", fontWeight:700, marginTop:fixes.length>0?12:0, marginBottom:7 }}>⚠ Warnings (review recommended)</div>
              {warnings.map((issue,i) => (
                <div key={i} style={{ color:C.warn, fontSize:12, lineHeight:1.7, paddingLeft:8 }}>{issue}</div>
              ))}
            </>
          )}
          <div style={{ marginTop:8, paddingTop:8, borderTop:`1px solid ${C.border}`, color:C.textDim, fontSize:10 }}>Clarix Auto-Clean · all changes applied before analysis</div>
        </div>
      )}
    </div>
  );
}

// ─── LOB VIEW (department detail) ─────────────────────────────────────────────
function LOBView({ lob, color, role, C, onBack }) {
  const [insight, setInsight] = useState(null);
  const [loading, setLoading] = useState(false);
  const [done,    setDone]    = useState(false);
  const m = computeMetrics(lob.data, lob.name, lob.mapping, lob.lobType);
  const fmt = v => v>999999?`${(v/1e6).toFixed(1)}M`:v>999?`${(v/1000).toFixed(0)}K`:v%1===0?String(Math.round(v)):v.toFixed(1);
  const numCols = Object.keys(lob.data[0]).filter(k=>!isNaN(parseFloat(String(lob.data[0][k]).replace(/[,$%]/g,"")))).slice(0,5);

  const buildRCAPrompt = () => {
    // Determine department type label for strong prompt differentiation
    const deptTypeLabel = m._type==="call" ? "CALL OPERATIONS"
      : m._type==="transport" ? "TRANSPORT & ATTENDANCE"
      : m._type==="docs" ? "DOCUMENT PROCESSING"
      : m._type==="scheduling" ? "WORKFORCE SCHEDULING"
      : lob.name.toUpperCase();

    // Build role-specific audience context
    const roleLabel = role==="director" ? "Director / Executive"
      : role==="teamlead" ? "Team Lead / Manager"
      : "Employee";

    // Build rich, type-specific metric summary
    const riskSummary = m._type==="call"
      ? `Drop Rate: ${m._drop_rate}% (target <7%) | Avg CSAT: ${m._csat}/5.0 | Avg AHT: ${m._aht_min} min | FCR: ${m._fcr||"N/A"}%`
      : m._type==="transport"
      ? `No-Show Rate: ${m._no_show_rate}% (target <10%) | Total No-Shows: ${m._no_shows} of ${lob.data.length} records | At-Risk Agents (2+ absences): ${(m._at_risk||[]).join(", ")||"None"}`
      : m._type==="docs"
      ? `Avg Rejection Rate: ${m._avg_rejection}% (target <8%) | Avg Processing Time: ${m._avg_process} min | Total Docs Rejected: ${m._total_rejected} | Total Processed: ${m._total_processed}`
      : m._type==="scheduling"
      ? `Avg Schedule Adherence: ${m._adherence}% (target >90%) | Late Logins: ${m._late_count} instances | Risk Level: ${m._risk}`
      : lob.csvText ? lob.csvText.split("\n").slice(0,6).join("\n") : "No structured metrics available.";

    // Build agent breakdown filtered by role
    // Employees only see their own row; managers/directors see all agents
    let agentLines = "";
    if (role === "employee") {
      // Try to find the first agent name and filter to just that person's rows
      const agentKey = lob.data.length > 0
        ? Object.keys(lob.data[0]).find(k => ["agent","employee","name"].includes(k.toLowerCase())) || Object.keys(lob.data[0])[0]
        : null;
      const myName = agentKey ? lob.data[0][agentKey] : null;
      const myRows = myName ? lob.data.filter(r => r[agentKey] === myName) : lob.data.slice(0,3);
      agentLines = myRows.map(r => "  " + Object.entries(r).map(([k,v])=>`${k}=${v}`).join(", ")).join("\n");
    } else if (m._agents) {
      agentLines = m._agents.map(a=>`  ${a.name}: calls_answered=${a.calls}, calls_dropped=${a.dropped}, avg_csat=${a.csat}, avg_aht=${a.aht}s`).join("\n");
    } else if (m._top_rejectors) {
      agentLines = m._top_rejectors.map(a=>`  ${a.name}: avg_rejection_rate=${a.rate}%, avg_process_time=${a.time}min, total_rejected=${a.rejected||"?"}`).join("\n");
    } else if (m._transport_agents) {
      agentLines = m._transport_agents.map(a=>`  ${a.name}: no_shows=${a.noShows}, monthly_no_shows=${a.monthlyNs}`).join("\n");
    } else if (m._low_adherence) {
      agentLines = m._low_adherence.map(a=>`  ${a.name}: avg_adherence=${a.adherence}%, late_login_count=${a.late}, break_violations=${a.bv}`).join("\n");
    } else if (lob.csvText) {
      agentLines = lob.csvText.split("\n").slice(0, 16).join("\n");
    }

    // Role-specific instruction frame
    const roleInstruction = role === "director"
      ? `You are briefing an executive DIRECTOR on the ${lob.name} department. Focus on: strategic risk exposure, cross-team implications, resource/policy decisions needed at leadership level, and business impact in measurable terms.`
      : role === "teamlead"
      ? `You are briefing the TEAM LEAD managing the ${lob.name} department. Focus on: specific agent-level coaching targets, operational adjustments the team lead can make this week, which employees need support, and team-level process fixes.`
      : `You are briefing an EMPLOYEE in the ${lob.name} department about their own performance. Focus on: personal metric trends, what they can improve individually, specific behaviours linked to their numbers, and constructive next steps.`;

    // Type-specific metric focus to force differentiated output per department
    const typeInstruction = m._type === "call"
      ? `KEY METRICS FOR THIS DEPT: Call Drop Rate, CSAT score, Average Handle Time (AHT), First Contact Resolution (FCR). The drop rate and CSAT are the headline KPIs. Reference specific agent CSAT scores and call volumes.`
      : m._type === "transport"
      ? `KEY METRICS FOR THIS DEPT: No-Show Rate, repeat absences (monthly count), transport route reliability. Name the specific at-risk employees. Attendance patterns and incentive eligibility are the headline concerns.`
      : m._type === "docs"
      ? `KEY METRICS FOR THIS DEPT: Document Rejection Rate, Processing Time, total docs rejected vs processed. Name agents with the highest rejection rates. Rework cost and processing backlog are the headline concerns.`
      : m._type === "scheduling"
      ? `KEY METRICS FOR THIS DEPT: Schedule Adherence %, Late Login count, Break Violations. Name agents with lowest adherence. Floor coverage gap and queue impact are the headline concerns.`
      : `KEY METRICS FOR THIS DEPT: Analyse the columns present in the data — focus on whichever metrics show the greatest deviation from expected performance.`;

    const sys = `You are an operational intelligence analyst. You are performing a ROOT CAUSE ANALYSIS specifically for the ${deptTypeLabel} department.\n\n${roleInstruction}\n\n${typeInstruction}\n\nIMPORTANT: Your analysis MUST be specific to ${deptTypeLabel} and must reference the exact numbers, agent names, and metric types from the data provided. Do NOT give generic advice.\n\nWrite EXACTLY in this format (no extra text before or after):\nROOT CAUSE: [The primary underlying cause specific to ${deptTypeLabel} performance — 2 sentences with exact numbers from this dataset]\nCONTRIBUTING FACTORS:\n• [Factor 1 — cite a specific agent name or metric value from the data]\n• [Factor 2 — cite a specific agent name or metric value from the data]\n• [Factor 3 — cite a specific agent name or metric value from the data]\n⚠ HIGHEST RISK: [The single most urgent issue — name the specific agent or exact metric threshold being breached]\n→ IMMEDIATE ACTION: [One specific action the ${roleLabel} should take within 24 hours — be operational, not generic]\n→ 30-DAY PLAN: [One structural intervention to fix the root cause — specific to ${deptTypeLabel}]\n\nDo NOT start any line with generic phrases like "The department" — use specific names and numbers throughout.`;

    const userMsg = `DEPARTMENT: ${lob.name} (${deptTypeLabel})\nVIEWING AS: ${roleLabel}\nRISK LEVEL: ${m._risk || "UNKNOWN"}\nTOTAL RECORDS ANALYSED: ${lob.data.length}\n\nKEY METRIC SUMMARY:\n${riskSummary}\n\nAGENT / EMPLOYEE BREAKDOWN:\n${agentLines}`;

    return { sys, userMsg };
  };

  const generate = async () => {
    setLoading(true); setDone(true);
    try {
      const { sys, userMsg } = buildRCAPrompt();
      const text = await callAI(sys, userMsg, 900);
      setInsight(text);
    } catch(e) { setInsight(`⚠ ${e.message}`); }
    setLoading(false);
  };

  const briefingLabel = "Root Cause Analysis";

  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16 }}>
        <BackBtn onClick={onBack} C={C}/>
        <div>
          <h2 style={{ margin:0, fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:700, fontSize:18 }}><span style={{ color }}>{lob.name}</span></h2>
          <div style={{ color:C.textDim, fontSize:12 }}>{lob.data.length} records · {Object.keys(lob.data[0]).length} metrics · {ACCOUNTS[role]?.label||role} view</div>
        </div>
        <RiskBadge level={m._risk} C={C}/>
      </div>

      {m._risk==="HIGH"&&<div style={{ background:C.dangerSoft, border:`1px solid ${C.danger}44`, borderRadius:9, padding:"10px 14px", marginBottom:16, color:C.danger, fontSize:13, fontWeight:600 }}>🚨 High risk — requires immediate attention</div>}

      <DataCleaningReport issues={lob.cleaningIssues} C={C}/>

      <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginBottom:18 }}>
        {numCols.map(col=><StatCard key={col} label={col} value={fmt(m[col+"_total"]||0)} sub={`avg ${fmt(m[col+"_avg"]||0)}`} color={color} C={C}/>)}
        {m._drop_rate!=null&&m._drop_rate!==undefined&&<StatCard label="Drop Rate" value={`${m._drop_rate}%`} sub="calls dropped" color={parseFloat(m._drop_rate)>10?C.danger:C.success} C={C}/>}
        {m._csat!=null&&m._csat!==undefined&&<StatCard label="Avg CSAT" value={m._csat} sub="/5.0" color={parseFloat(m._csat)<4.0?C.warn:C.success} C={C}/>}
        {m._no_show_rate!=null&&m._no_show_rate!==undefined&&<StatCard label="No-Show Rate" value={`${m._no_show_rate}%`} sub={`${m._no_shows} incidents`} color={parseFloat(m._no_show_rate)>15?C.danger:C.warn} C={C}/>}
        {m._avg_rejection!=null&&m._avg_rejection!==undefined&&<StatCard label="Avg Rejection" value={`${m._avg_rejection}%`} sub={`${m._avg_process}m avg`} color={parseFloat(m._avg_rejection)>10?C.danger:C.warn} C={C}/>}
        {m._adherence!=null&&m._adherence!==undefined&&<StatCard label="Adherence" value={`${m._adherence}%`} sub={`${m._late_count} late`} color={parseFloat(m._adherence)<85?C.danger:C.success} C={C}/>}
      </div>

      {m._at_risk&&m._at_risk.length>0&&<div style={{ background:C.dangerSoft, border:`1px solid ${C.danger}44`, borderRadius:9, padding:"11px 14px", marginBottom:16 }}><div style={{ color:C.danger, fontSize:11, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>⚠ Incentive Eligibility At Risk</div><div style={{ color:C.text, fontSize:13 }}>{m._at_risk.join(", ")} — 2+ absences this month.</div></div>}

      {m._agents&&<div style={{ marginBottom:16 }}><div style={{ color:C.textDim, fontSize:11, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:7, fontWeight:600 }}>Agent Performance</div><MiniTable rows={m._agents} headers={["name","calls","dropped","csat","aht"]} C={C}/></div>}
      {m._top_rejectors&&<div style={{ marginBottom:16 }}><div style={{ color:C.textDim, fontSize:11, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:7, fontWeight:600 }}>Highest Rejection Rates</div><MiniTable rows={m._top_rejectors} headers={["name","rate","time"]} C={C}/></div>}
      {m._low_adherence&&<div style={{ marginBottom:16 }}><div style={{ color:C.textDim, fontSize:11, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:7, fontWeight:600 }}>Lowest Adherence</div><MiniTable rows={m._low_adherence} headers={["name","adherence","late","bv"]} C={C}/></div>}

      {loading&&<Spinner C={C} label="Generating root cause analysis..."/>}
      {insight&&!loading&&<AIResult text={insight} color={color} label={`${lob.name} · Root Cause Analysis`} C={C}/>}
      {!done&&!loading&&<button onClick={generate} style={{ background:color, color:"#fff", border:"none", borderRadius:8, padding:"9px 18px", fontSize:13, fontWeight:600, cursor:"pointer", marginBottom:18 }}>◈ AI Intelligence — Root Cause Analysis</button>}
      {done&&!loading&&<button onClick={()=>{ setInsight(null); setDone(false); }} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:8, padding:"7px 15px", fontSize:12, cursor:"pointer", marginBottom:18 }}>↺ Re-run Analysis</button>}

      <div style={{ color:C.textDim, fontSize:11, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:7, fontWeight:600 }}>Source Data</div>
      <RawTable data={lob.data} C={C}/>
    </div>
  );
}

// ─── MEMORY LAYER ─────────────────────────────────────────────────────────────
function EventCard({ event, allEvents, onEdit, C, expanded, onToggle }) {
  const [aiInsight, setAiInsight] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiDone,    setAiDone]    = useState(false);
  const etype  = EVENT_TYPES.find(e=>e.id===event.type)||EVENT_TYPES[0];
  const ocfg   = OUTCOME_CFG[event.outcome]||OUTCOME_CFG.pending;
  const linked = allEvents.find(e=>e.id===event.linked_event);

  const generateInsight = async () => {
    setAiLoading(true); setAiDone(true);
    try {
      const bStr=event.metrics_before?Object.entries(event.metrics_before).map(([k,v])=>`${k}: ${v}`).join(", "):"N/A";
      const aStr=event.metrics_after&&Object.keys(event.metrics_after).length?Object.entries(event.metrics_after).map(([k,v])=>`${k}: ${v}`).join(", "):"Pending";
      const text = await callAI(
        `You are an operational intelligence analyst. Generate a concise institutional learning note.\nWrite:\nLEARNING: [What this event taught the organisation — 2 sentences max]\nPATTERN: [Whether similar interventions worked before and what conditions matter — 1 sentence]\n→ REAPPLY: [When leadership should consider this again — 1 sentence]\nBe specific. Reference the actual metrics.`,
        `Event: ${event.title}\nType: ${event.type}\nDept: ${event.dept}\nDescription: ${event.description}\nBefore: ${bStr}\nAfter: ${aStr}\nOutcome: ${event.outcome}\nNotes: ${event.outcome_note||"N/A"}`,
        500
      );
      setAiInsight(text);
    } catch(e) { setAiInsight(`⚠ ${e.message}`); }
    setAiLoading(false);
  };

  return (
    <div style={{ background:C.surface, border:`1px solid ${expanded?etype.color+"66":C.border}`, borderRadius:12, overflow:"hidden", transition:"border-color 0.15s" }}>
      <div onClick={onToggle} style={{ padding:"14px 16px", cursor:"pointer", display:"flex", alignItems:"flex-start", gap:12 }}>
        <div style={{ width:32, height:32, borderRadius:"50%", background:`${etype.color}20`, border:`2px solid ${etype.color}`, display:"flex", alignItems:"center", justifyContent:"center", color:etype.color, fontSize:13, fontWeight:700, flexShrink:0 }}>{etype.icon}</div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap", marginBottom:4 }}>
            <span style={{ color:etype.color, fontSize:10, textTransform:"uppercase", letterSpacing:"0.07em", fontWeight:700 }}>{etype.label}</span>
            <span style={{ color:C.textDim, fontSize:10 }}>· {event.dept} · <span style={{ fontFamily:"monospace" }}>{event.date}</span></span>
            <span style={{ marginLeft:"auto", background:ocfg.soft, color:ocfg.color, border:`1px solid ${ocfg.color}44`, borderRadius:5, padding:"2px 8px", fontSize:10, fontWeight:700 }}>{ocfg.icon} {ocfg.label}</span>
          </div>
          <div style={{ color:C.text, fontSize:14, fontWeight:600, lineHeight:1.4, marginBottom:2 }}>{event.title}</div>
          <div style={{ color:C.textDim, fontSize:12 }}>{event.author}</div>
        </div>
        <span style={{ color:C.textDim, fontSize:11, flexShrink:0, marginTop:4 }}>{expanded?"▲":"▼"}</span>
      </div>
      {expanded&&(
        <div style={{ padding:"0 16px 16px 60px", borderTop:`1px solid ${C.border}` }}>
          <div style={{ color:C.text, fontSize:13, lineHeight:1.7, margin:"14px 0 12px", padding:"12px 14px", background:C.surfaceHigh, borderRadius:9, borderLeft:`3px solid ${etype.color}` }}>{event.description}</div>
          {event.metrics_before&&Object.keys(event.metrics_before).length>0&&<div style={{ marginBottom:14 }}><div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.07em", fontWeight:600, marginBottom:6 }}>Metric Impact</div><MetricDelta before={event.metrics_before} after={event.metrics_after} C={C}/></div>}
          {event.outcome_note&&<div style={{ background:ocfg.soft, border:`1px solid ${ocfg.color}44`, borderRadius:9, padding:"12px 14px", marginBottom:14 }}><div style={{ color:ocfg.color, fontSize:10, textTransform:"uppercase", letterSpacing:"0.07em", fontWeight:700, marginBottom:5 }}>{ocfg.icon} Observed Outcome</div><div style={{ color:C.text, fontSize:13, lineHeight:1.65 }}>{event.outcome_note}</div></div>}
          {linked&&<div style={{ background:C.surfaceHigh, border:`1px solid ${C.border}`, borderRadius:9, padding:"10px 14px", marginBottom:14, display:"flex", alignItems:"center", gap:10 }}><span style={{ color:C.textDim, fontSize:12 }}>🔗 Linked:</span><span style={{ color:C.accent, fontSize:13, fontWeight:500 }}>{linked.title}</span></div>}
          {event.tags&&event.tags.length>0&&<div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:14 }}>{event.tags.map(t=><span key={t} style={{ background:C.surfaceHigh, border:`1px solid ${C.border}`, color:C.textDim, borderRadius:5, padding:"2px 8px", fontSize:11, fontFamily:"monospace" }}>#{t}</span>)}</div>}
          {aiLoading&&<Spinner C={C} label="Extracting learning..."/>}
          {aiInsight&&!aiLoading&&(
            <div style={{ background:C.purpleSoft, border:`1px solid ${C.purple}44`, borderRadius:10, padding:"14px 16px", marginBottom:12, animation:"fadeIn 0.3s ease" }}>
              <div style={{ color:C.purple, fontSize:10, textTransform:"uppercase", letterSpacing:"0.09em", fontWeight:700, marginBottom:10 }}>◎ Institutional Learning · AI Analysis</div>
              {aiInsight.split("\n").filter(Boolean).map((line,i)=>(
                <div key={i} style={{ color:line.startsWith("→")?C.purple:line.startsWith("PATTERN")?C.warn:C.text, fontSize:13, lineHeight:1.75, marginBottom:4, fontWeight:line.startsWith("→")?600:400 }}>{line}</div>
              ))}
              <div style={{ marginTop:8, paddingTop:8, borderTop:`1px solid ${C.border}`, color:C.textDim, fontSize:10 }}>AI-generated · Clarix Memory Layer</div>
            </div>
          )}
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            {!aiDone&&<button onClick={generateInsight} style={{ background:C.purple, color:"#fff", border:"none", borderRadius:7, padding:"6px 14px", fontSize:12, fontWeight:600, cursor:"pointer" }}>◎ Extract Learning</button>}
            <button onClick={()=>onEdit(event)} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:7, padding:"6px 12px", fontSize:12, cursor:"pointer" }}>Edit</button>
          </div>
        </div>
      )}
    </div>
  );
}

function EventModal({ onSave, onClose, allEvents, editEvent, C }) {
  const blank={ id:"", date:new Date().toISOString().slice(0,10), type:"intervention", dept:"Call Operations", title:"", description:"", author:"", role:"teamlead", metrics_before:{}, metrics_after:{}, outcome:"pending", outcome_note:"", tags:[], linked_event:"" };
  const [form,setForm]=useState(editEvent||blank);
  const [tagInput,setTagInput]=useState((editEvent?.tags||[]).join(", "));
  const [mBefore,setMBefore]=useState(editEvent?Object.entries(editEvent.metrics_before||{}).map(([k,v])=>({k,v})):[{k:"",v:""}]);
  const [mAfter,setMAfter]=useState(editEvent?Object.entries(editEvent.metrics_after||{}).map(([k,v])=>({k,v})):[{k:"",v:""}]);
  const [error,setError]=useState("");
  const S=GS2(C);

  const save=()=>{
    if(!form.title.trim()){setError("Title is required.");return;}
    if(!form.description.trim()){setError("Description is required.");return;}
    if(!form.author.trim()){setError("Author name is required.");return;}
    const mb={};mBefore.forEach(({k,v})=>{if(k.trim())mb[k.trim()]=v;});
    const ma={};mAfter.forEach(({k,v})=>{if(k.trim())ma[k.trim()]=v;});
    onSave({...form,id:form.id||`evt_${Date.now()}`,tags:tagInput.split(",").map(t=>t.trim()).filter(Boolean),metrics_before:mb,metrics_after:ma});
  };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.75)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:16, width:"100%", maxWidth:600, maxHeight:"88vh", overflowY:"auto", padding:22 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:18 }}>
          <h3 style={{ margin:0, fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:700, fontSize:17 }}>{editEvent?"Edit Event":"Log New Event"}</h3>
          <button onClick={onClose} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:6, padding:"4px 10px", cursor:"pointer" }}>✕</button>
        </div>
        {error&&<div style={{ background:C.dangerSoft, border:`1px solid ${C.danger}44`, borderRadius:8, padding:"8px 12px", marginBottom:14, color:C.danger, fontSize:13 }}>{error}</div>}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:11, marginBottom:11 }}>
          <div><label style={S.lbl}>Event Type</label><select style={{...S.inp,cursor:"pointer"}} value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value}))}>{EVENT_TYPES.map(t=><option key={t.id} value={t.id}>{t.icon} {t.label}</option>)}</select></div>
          <div><label style={S.lbl}>Date</label><input type="date" style={S.inp} value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))}/></div>
        </div>
        <div style={{ marginBottom:11 }}><label style={S.lbl}>Department</label><select style={{...S.inp,cursor:"pointer"}} value={form.dept} onChange={e=>setForm(f=>({...f,dept:e.target.value}))}>{DEPTS.filter(d=>d!=="All Departments").map(d=><option key={d}>{d}</option>)}</select></div>
        <div style={{ marginBottom:11 }}><label style={S.lbl}>Event Title *</label><input style={S.inp} placeholder="What happened?" value={form.title} onChange={e=>setForm(f=>({...f,title:e.target.value}))}/></div>
        <div style={{ marginBottom:11 }}><label style={S.lbl}>Description *</label><textarea style={{...S.inp,minHeight:80,resize:"vertical"}} placeholder="Who was involved? What decision was made?" value={form.description} onChange={e=>setForm(f=>({...f,description:e.target.value}))}/></div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:11, marginBottom:11 }}>
          <div><label style={S.lbl}>Logged By *</label><input style={S.inp} placeholder="Name or role" value={form.author} onChange={e=>setForm(f=>({...f,author:e.target.value}))}/></div>
          <div><label style={S.lbl}>Outcome</label><select style={{...S.inp,cursor:"pointer"}} value={form.outcome} onChange={e=>setForm(f=>({...f,outcome:e.target.value}))}>{Object.entries(OUTCOME_CFG).map(([k,v])=><option key={k} value={k}>{v.icon} {v.label}</option>)}</select></div>
        </div>
        <div style={{ marginBottom:11 }}>
          <label style={S.lbl}>Metrics Before</label>
          {mBefore.map((row,i)=>(
            <div key={i} style={{ display:"flex", gap:7, marginBottom:6 }}>
              <select style={{...S.inp,flex:1,cursor:"pointer"}} value={row.k} onChange={e=>{const n=[...mBefore];n[i]={...n[i],k:e.target.value};setMBefore(n);}}><option value="">Select metric...</option>{METRIC_KEYS.map(m=><option key={m.key} value={m.key}>{m.label}</option>)}</select>
              <input style={{...S.inp,width:90}} placeholder="Value" value={row.v} onChange={e=>{const n=[...mBefore];n[i]={...n[i],v:e.target.value};setMBefore(n);}}/>
              <button onClick={()=>setMBefore(p=>p.filter((_,j)=>j!==i))} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.danger, borderRadius:6, padding:"0 8px", cursor:"pointer" }}>×</button>
            </div>
          ))}
          <button onClick={()=>setMBefore(p=>[...p,{k:"",v:""}])} style={{ background:"transparent", border:`1px dashed ${C.border}`, color:C.textDim, borderRadius:6, padding:"5px 12px", fontSize:12, cursor:"pointer" }}>+ Add metric</button>
        </div>
        {form.outcome!=="pending"&&(
          <div style={{ marginBottom:11 }}>
            <label style={S.lbl}>Metrics After</label>
            {mAfter.map((row,i)=>(
              <div key={i} style={{ display:"flex", gap:7, marginBottom:6 }}>
                <select style={{...S.inp,flex:1,cursor:"pointer"}} value={row.k} onChange={e=>{const n=[...mAfter];n[i]={...n[i],k:e.target.value};setMAfter(n);}}><option value="">Select metric...</option>{METRIC_KEYS.map(m=><option key={m.key} value={m.key}>{m.label}</option>)}</select>
                <input style={{...S.inp,width:90}} placeholder="Value" value={row.v} onChange={e=>{const n=[...mAfter];n[i]={...n[i],v:e.target.value};setMAfter(n);}}/>
                <button onClick={()=>setMAfter(p=>p.filter((_,j)=>j!==i))} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.danger, borderRadius:6, padding:"0 8px", cursor:"pointer" }}>×</button>
              </div>
            ))}
            <button onClick={()=>setMAfter(p=>[...p,{k:"",v:""}])} style={{ background:"transparent", border:`1px dashed ${C.border}`, color:C.textDim, borderRadius:6, padding:"5px 12px", fontSize:12, cursor:"pointer" }}>+ Add metric</button>
          </div>
        )}
        <div style={{ marginBottom:11 }}><label style={S.lbl}>Outcome Notes</label><textarea style={{...S.inp,minHeight:60,resize:"vertical"}} placeholder="What happened after? What did you learn?" value={form.outcome_note} onChange={e=>setForm(f=>({...f,outcome_note:e.target.value}))}/></div>
        <div style={{ marginBottom:18 }}><label style={S.lbl}>Tags (comma-separated)</label><input style={S.inp} placeholder="coaching, csat, policy..." value={tagInput} onChange={e=>setTagInput(e.target.value)}/></div>
        <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
          <button onClick={onClose} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:8, padding:"9px 18px", fontSize:13, cursor:"pointer" }}>Cancel</button>
          <button onClick={save} style={{ background:C.accent, color:"#fff", border:"none", borderRadius:8, padding:"9px 20px", fontSize:13, fontWeight:600, cursor:"pointer" }}>Save Event</button>
        </div>
      </div>
    </div>
  );
}

function MemoryLayer({ events, setEvents, C, onBack }) {
  const [showModal, setShowModal] = useState(false);
  const [editEvent, setEditEvent] = useState(null);
  const [expanded,  setExpanded]  = useState({});
  const [filterDept,setFilterDept]= useState("All Departments");
  const [filterType,setFilterType]= useState("all");
  const [filterOut, setFilterOut] = useState("all");
  const [search,    setSearch]    = useState("");
  const [aiSummary, setAiSummary] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiDone,    setAiDone]    = useState(false);

  const handleSave = evt => { setEvents(prev=>prev.find(e=>e.id===evt.id)?prev.map(e=>e.id===evt.id?evt:e):[evt,...prev]); setShowModal(false); setEditEvent(null); };
  const handleDelete = id => { if(window.confirm("Delete this event?")) setEvents(prev=>prev.filter(e=>e.id!==id)); };

  const filtered = events.filter(e=>{
    if(filterDept!=="All Departments"&&e.dept!==filterDept) return false;
    if(filterType!=="all"&&e.type!==filterType) return false;
    if(filterOut!=="all"&&e.outcome!==filterOut) return false;
    if(search){const q=search.toLowerCase();if(!e.title.toLowerCase().includes(q)&&!e.description.toLowerCase().includes(q)&&!(e.tags||[]).join(" ").toLowerCase().includes(q))return false;}
    return true;
  }).sort((a,b)=>b.date.localeCompare(a.date));

  const generateSummary = async () => {
    setAiLoading(true); setAiDone(true);
    try {
      const evtStr=events.slice(0,8).map(e=>`[${e.date}] ${e.type.toUpperCase()} — ${e.title} | Dept: ${e.dept} | Outcome: ${e.outcome} | ${e.outcome_note||""}`).join("\n");
      const text = await callAI(
        `You are analysing an organisation's operational decision history. Generate an institutional intelligence summary.\nWrite:\nPATTERN: [The most significant operational pattern across these events — 2 sentences]\nWHAT WORKED: [The intervention type with the most consistent improvement — 1 sentence with evidence]\nWHAT DIDN'T: [Any decision that worsened metrics or had mixed results — 1 sentence]\n⚠ WATCH: [A risk or gap suggested by this history — 1 sentence]\n→ RECOMMEND: [One organisational action suggested by the history — 1 sentence]\nBe specific. Reference actual events and departments.`,
        `Operational history:\n${evtStr}`, 700
      );
      setAiSummary(text);
    } catch(e) { setAiSummary(`⚠ ${e.message}`); }
    setAiLoading(false);
  };

  const improved=events.filter(e=>e.outcome==="improved").length;
  const worsened=events.filter(e=>e.outcome==="worsened").length;
  const pending=events.filter(e=>e.outcome==="pending").length;

  return (
    <div>
      {showModal&&<EventModal onSave={handleSave} onClose={()=>{setShowModal(false);setEditEvent(null);}} allEvents={events} editEvent={editEvent} C={C}/>}

      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:18 }}>
        <BackBtn onClick={onBack} C={C}/>
        <div>
          <h2 style={{ margin:0, fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:700, fontSize:18 }}><span style={{ color:C.purple }}>◎ Memory</span> Layer</h2>
          <div style={{ color:C.textDim, fontSize:12 }}>Institutional knowledge · {events.length} events</div>
        </div>
      </div>

      <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginBottom:20 }}>
        {[{label:"Total Events",val:events.length,bg:C.surfaceHigh,color:C.text,bord:C.border},{label:"Improved",val:improved,bg:C.successSoft,color:C.success,bord:C.success},{label:"Worsened",val:worsened,bg:C.dangerSoft,color:C.danger,bord:C.danger},{label:"Pending",val:pending,bg:C.accentSoft,color:C.accent,bord:C.accent}].map(s=>(
          <div key={s.label} style={{ background:s.bg, border:`1px solid ${s.bord}44`, borderRadius:10, padding:"12px 16px", flex:"1 1 100px" }}>
            <div style={{ color:s.color, fontSize:10, textTransform:"uppercase", letterSpacing:"0.07em", fontWeight:700, marginBottom:4 }}>{s.label}</div>
            <div style={{ color:s.color, fontSize:25, fontWeight:800, fontFamily:"monospace" }}>{s.val}</div>
          </div>
        ))}
        <button onClick={()=>setShowModal(true)} style={{ background:C.accent, color:"#fff", border:"none", borderRadius:10, padding:"12px 20px", fontSize:13, fontWeight:700, cursor:"pointer", flexShrink:0, alignSelf:"stretch" }}>+ Log Event</button>
      </div>

      {aiLoading&&<Spinner C={C} label="Generating organisational intelligence..."/>}
      {aiSummary&&!aiLoading&&(
        <div style={{ background:C.purpleSoft, border:`1px solid ${C.purple}44`, borderRadius:12, padding:"16px 18px", marginBottom:20, animation:"fadeIn 0.3s ease" }}>
          <div style={{ color:C.purple, fontSize:10, textTransform:"uppercase", letterSpacing:"0.1em", fontWeight:700, marginBottom:10 }}>◎ Organisational Intelligence Summary</div>
          {aiSummary.split("\n").filter(Boolean).map((line,i)=>(
            <div key={i} style={{ color:line.startsWith("⚠")?C.warn:line.startsWith("→")?C.purple:line.startsWith("WHAT DIDN")?C.danger:C.text, fontSize:13, lineHeight:1.8, marginBottom:4, fontWeight:line.startsWith("→")||line.startsWith("PATTERN")?600:400 }}>{line}</div>
          ))}
          <div style={{ marginTop:10, paddingTop:8, borderTop:`1px solid ${C.border}`, color:C.textDim, fontSize:10 }}>Derived from {events.length} logged events · Clarix Memory Layer</div>
        </div>
      )}
      {!aiDone&&events.length>=2&&<button onClick={generateSummary} style={{ background:C.purple, color:"#fff", border:"none", borderRadius:8, padding:"9px 18px", fontSize:13, fontWeight:600, cursor:"pointer", marginBottom:20 }}>◎ Generate Organisational Intelligence</button>}

      <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:14, padding:"11px 13px", background:C.surfaceHigh, borderRadius:10, border:`1px solid ${C.border}` }}>
        <input style={{ background:C.surface, border:`1px solid ${C.border}`, color:C.text, borderRadius:7, padding:"6px 11px", fontSize:12, flex:"1 1 150px", outline:"none" }} placeholder="Search events, tags..." value={search} onChange={e=>setSearch(e.target.value)}/>
        <select style={{ background:C.surface, border:`1px solid ${C.border}`, color:C.text, borderRadius:7, padding:"6px 10px", fontSize:12, cursor:"pointer" }} value={filterDept} onChange={e=>setFilterDept(e.target.value)}>{DEPTS.map(d=><option key={d}>{d}</option>)}</select>
        <select style={{ background:C.surface, border:`1px solid ${C.border}`, color:C.text, borderRadius:7, padding:"6px 10px", fontSize:12, cursor:"pointer" }} value={filterType} onChange={e=>setFilterType(e.target.value)}><option value="all">All Types</option>{EVENT_TYPES.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}</select>
        <select style={{ background:C.surface, border:`1px solid ${C.border}`, color:C.text, borderRadius:7, padding:"6px 10px", fontSize:12, cursor:"pointer" }} value={filterOut} onChange={e=>setFilterOut(e.target.value)}><option value="all">All Outcomes</option>{Object.entries(OUTCOME_CFG).map(([k,v])=><option key={k} value={k}>{v.icon} {v.label}</option>)}</select>
      </div>

      <div style={{ color:C.textDim, fontSize:11, textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:11, fontWeight:600 }}>{filtered.length} event{filtered.length!==1?"s":""}</div>
      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        {filtered.length===0?<div style={{ textAlign:"center", padding:"40px 0", color:C.textDim }}><div style={{ fontSize:22, marginBottom:8 }}>◎</div><div style={{ fontSize:14, fontWeight:600, color:C.text }}>No events match your filters</div></div>
          :filtered.map(evt=><EventCard key={evt.id} event={evt} allEvents={events} onEdit={ev=>{setEditEvent(ev);setShowModal(true);}} C={C} expanded={!!expanded[evt.id]} onToggle={()=>setExpanded(p=>({...p,[evt.id]:!p[evt.id]}))}/>)}
      </div>
    </div>
  );
}


// ─── INTEGRATIONS PAGE ───────────────────────────────────────────────────────
const INTEGRATIONS = [
  {
    category: "Communication & Ticketing",
    tools: [
      { id:"zendesk",    name:"Zendesk",        icon:"🎫", desc:"Sync ticket volumes and CSAT scores directly into Clarix dashboards.", status:"available", color:"#03363d" },
      { id:"freshdesk",  name:"Freshdesk",      icon:"💬", desc:"Pull agent performance, first response time, and resolution rates.", status:"available", color:"#25c16f" },
      { id:"slack",      name:"Slack",           icon:"💼", desc:"Receive early warning alerts and daily briefings in Slack channels.", status:"available", color:"#4a154b" },
      { id:"teams",      name:"Microsoft Teams", icon:"🟦", desc:"Push critical alerts and AI summaries into Teams channels.", status:"available", color:"#5059c9" },
    ]
  },
  {
    category: "Workforce Management",
    tools: [
      { id:"genesys",    name:"Genesys Cloud",  icon:"☁️", desc:"Import real-time call data — AHT, drop rates, queue metrics.", status:"available", color:"#ff4f1f" },
      { id:"nice",       name:"NICE inContact",  icon:"📞", desc:"Ingest agent adherence and workforce scheduling data.", status:"coming", color:"#0061a1" },
      { id:"aspect",     name:"Aspect WFM",      icon:"📅", desc:"Sync shift schedules and adherence data automatically.", status:"coming", color:"#e2691e" },
      { id:"verint",     name:"Verint",          icon:"📊", desc:"Pull quality monitoring scores and interaction analytics.", status:"coming", color:"#002855" },
    ]
  },
  {
    category: "HR & Payroll",
    tools: [
      { id:"workday",    name:"Workday",         icon:"🏢", desc:"Sync employee attendance, leave, and incentive eligibility data.", status:"available", color:"#005587" },
      { id:"bamboohr",   name:"BambooHR",        icon:"🎋", desc:"Pull headcount, attrition, and HR event data into Memory Layer.", status:"available", color:"#73c41d" },
      { id:"adp",        name:"ADP",             icon:"💳", desc:"Import payroll cycles and incentive payout records.", status:"coming", color:"#d0021b" },
    ]
  },
  {
    category: "Analytics & Reporting",
    tools: [
      { id:"powerbi",    name:"Power BI",        icon:"📈", desc:"Embed Clarix intelligence panels directly in your BI dashboards.", status:"available", color:"#f2c811" },
      { id:"tableau",    name:"Tableau",         icon:"📉", desc:"Export Clarix processed metrics as Tableau-ready data sources.", status:"coming", color:"#e97627" },
      { id:"googlesheets",name:"Google Sheets",  icon:"📋", desc:"Sync department CSVs automatically from connected spreadsheets.", status:"available", color:"#0f9d58" },
    ]
  },
  {
    category: "Transport & Logistics",
    tools: [
      { id:"routematic", name:"Routematic",      icon:"🚌", desc:"Pull employee transport logs and no-show data in real time.", status:"available", color:"#0066cc" },
      { id:"moveinsync", name:"MoveInSync",      icon:"🗺️", desc:"Sync route adherence and boarding confirmation data.", status:"coming", color:"#ff6600" },
    ]
  },
];

function RequestIntegrationModal({ C, onClose, onSubmit }) {
  const [toolName, setToolName] = useState("");
  const [useCase,  setUseCase]  = useState("");
  const [email,    setEmail]    = useState("");
  const [priority, setPriority] = useState("medium");
  const S = GS2(C);
  const canSubmit = toolName.trim() && useCase.trim();
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.6)", zIndex:2000, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:16, width:"100%", maxWidth:480, padding:26, animation:"fadeIn 0.2s ease" }}>
        {/* Header */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
          <div>
            <h3 style={{ margin:0, fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:800, fontSize:17, color:C.text }}>Request an Integration</h3>
            <div style={{ color:C.textDim, fontSize:12, marginTop:2 }}>Tell us what to build next — we prioritise by demand.</div>
          </div>
          <button onClick={onClose} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:6, padding:"4px 10px", cursor:"pointer", fontSize:13 }}>✕</button>
        </div>

        <div style={{ borderTop:`1px solid ${C.border}`, margin:"16px 0" }}/>

        {/* Tool name */}
        <div style={{ marginBottom:14 }}>
          <label style={S.lbl}>Tool / Platform Name *</label>
          <input style={S.inp} placeholder="e.g. Salesforce, SAP, Zoho CRM..." value={toolName} onChange={e=>setToolName(e.target.value)}/>
        </div>

        {/* Use case */}
        <div style={{ marginBottom:14 }}>
          <label style={S.lbl}>What would you use it for? *</label>
          <textarea style={{...S.inp, minHeight:72, resize:"vertical"}} placeholder="e.g. Pull agent performance scores from Salesforce into Clarix dashboards automatically..." value={useCase} onChange={e=>setUseCase(e.target.value)}/>
        </div>

        {/* Priority */}
        <div style={{ marginBottom:14 }}>
          <label style={S.lbl}>How critical is this for your team?</label>
          <div style={{ display:"flex", gap:8 }}>
            {[{v:"low",label:"Nice to have",color:C.success},{v:"medium",label:"Important",color:C.warn},{v:"high",label:"Blocking us",color:C.danger}].map(p=>(
              <button key={p.v} onClick={()=>setPriority(p.v)} style={{ flex:1, background:priority===p.v?`${p.color}18`:"transparent", border:`1px solid ${priority===p.v?p.color:C.border}`, color:priority===p.v?p.color:C.textDim, borderRadius:8, padding:"8px 6px", fontSize:12, fontWeight:600, cursor:"pointer", transition:"all 0.15s" }}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Email */}
        <div style={{ marginBottom:20 }}>
          <label style={S.lbl}>Your email (optional — for updates)</label>
          <input style={S.inp} type="email" placeholder="you@company.com" value={email} onChange={e=>setEmail(e.target.value)}/>
        </div>

        {/* Footer */}
        <div style={{ display:"flex", gap:10, justifyContent:"flex-end" }}>
          <button onClick={onClose} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:8, padding:"9px 18px", fontSize:13, cursor:"pointer" }}>Cancel</button>
          <button onClick={()=>canSubmit&&onSubmit(toolName, priority)} disabled={!canSubmit}
            style={{ background:canSubmit?C.accent:"transparent", color:canSubmit?"#fff":C.textMuted, border:canSubmit?"none":`1px solid ${C.border}`, borderRadius:8, padding:"9px 22px", fontSize:13, fontWeight:700, cursor:canSubmit?"pointer":"not-allowed", transition:"all 0.15s" }}>
            Submit Request →
          </button>
        </div>
      </div>
    </div>
  );
}

function IntegrationsPage({ C, onBack }) {
  const [connected,    setConnected]    = useState({});
  const [search,       setSearch]       = useState("");
  const [toast,        setToast]        = useState(null);
  const [showReqModal, setShowReqModal] = useState(false);
  const [submitted,    setSubmitted]    = useState([]);

  const showToast = msg => { setToast(msg); setTimeout(()=>setToast(null), 3500); };

  const handleConnect = (toolId, toolName) => {
    setConnected(p=>({...p,[toolId]:!p[toolId]}));
    showToast(connected[toolId] ? `${toolName} disconnected` : `${toolName} connected successfully ✓`);
  };

  const handleRequestSubmit = (toolName, priority) => {
    setSubmitted(p=>[...p, { toolName, priority, id:Date.now() }]);
    setShowReqModal(false);
    showToast(`"${toolName}" request submitted — we'll prioritise it!`);
  };

  const filtered = INTEGRATIONS.map(cat=>({
    ...cat,
    tools: cat.tools.filter(t=>
      !search || t.name.toLowerCase().includes(search.toLowerCase()) || t.desc.toLowerCase().includes(search.toLowerCase())
    )
  })).filter(cat=>cat.tools.length>0);

  const totalConnected = Object.values(connected).filter(Boolean).length;

  return (
    <div>
      {/* Toast */}
      {toast && (
        <div style={{ position:"fixed", bottom:24, right:24, background:C.accent, color:"#fff", borderRadius:10, padding:"12px 20px", fontSize:13, fontWeight:600, zIndex:9999, animation:"fadeIn 0.25s ease", boxShadow:"0 6px 24px rgba(0,0,0,0.18)", maxWidth:320 }}>
          {toast}
        </div>
      )}

      {/* Request modal */}
      {showReqModal && <RequestIntegrationModal C={C} onClose={()=>setShowReqModal(false)} onSubmit={handleRequestSubmit}/>}

      {/* Page header */}
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:20 }}>
        <BackBtn onClick={onBack} C={C}/>
        <div style={{ flex:1 }}>
          <h2 style={{ margin:0, fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:700, fontSize:18 }}><span style={{ color:C.accent }}>⚡ Integrations</span></h2>
          <div style={{ color:C.textDim, fontSize:12 }}>Connect your tools · {totalConnected} active</div>
        </div>
        {/* Primary CTA — always visible in header for pitch */}
        <button onClick={()=>setShowReqModal(true)} style={{ background:C.accent, color:"#fff", border:"none", borderRadius:8, padding:"8px 16px", fontSize:12, fontWeight:700, cursor:"pointer", flexShrink:0, display:"flex", alignItems:"center", gap:6 }}>
          <span>＋</span> Request Integration
        </button>
      </div>

      {/* Stats row */}
      <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginBottom:20 }}>
        {[
          { label:"Available Now", val:INTEGRATIONS.flatMap(c=>c.tools).filter(t=>t.status==="available").length, bg:C.successSoft, color:C.success, bord:C.success },
          { label:"Coming Soon",   val:INTEGRATIONS.flatMap(c=>c.tools).filter(t=>t.status==="coming").length,    bg:C.warnSoft,    color:C.warn,    bord:C.warn    },
          { label:"Connected",     val:totalConnected,                                                             bg:C.accentSoft,  color:C.accent,  bord:C.accent  },
          { label:"Requested",     val:submitted.length,                                                           bg:C.purpleSoft,  color:C.purple,  bord:C.purple  },
        ].map(s=>(
          <div key={s.label} style={{ background:s.bg, border:`1px solid ${s.bord}44`, borderRadius:10, padding:"12px 16px", flex:"1 1 100px" }}>
            <div style={{ color:s.color, fontSize:10, textTransform:"uppercase", letterSpacing:"0.07em", fontWeight:700, marginBottom:4 }}>{s.label}</div>
            <div style={{ color:s.color, fontSize:24, fontWeight:800, fontFamily:"monospace" }}>{s.val}</div>
          </div>
        ))}
      </div>

      {/* Submitted requests — shown only after at least one request */}
      {submitted.length > 0 && (
        <div style={{ background:C.purpleSoft, border:`1px solid ${C.purple}44`, borderRadius:11, padding:"14px 18px", marginBottom:20, animation:"fadeIn 0.3s ease" }}>
          <div style={{ color:C.purple, fontSize:10, textTransform:"uppercase", letterSpacing:"0.09em", fontWeight:700, marginBottom:10 }}>◎ Your Requested Integrations</div>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {submitted.map(r=>{
              const pCfg = {high:[C.danger,"Blocking"],medium:[C.warn,"Important"],low:[C.success,"Nice to have"]}[r.priority]||[C.accent,"Medium"];
              return (
                <div key={r.id} style={{ display:"flex", alignItems:"center", gap:10, background:C.surface, border:`1px solid ${C.border}`, borderRadius:8, padding:"10px 13px" }}>
                  <span style={{ color:C.purple, fontSize:14 }}>◉</span>
                  <span style={{ color:C.text, fontWeight:600, fontSize:13, flex:1 }}>{r.toolName}</span>
                  <span style={{ background:`${pCfg[0]}18`, color:pCfg[0], border:`1px solid ${pCfg[0]}44`, borderRadius:5, padding:"2px 8px", fontSize:10, fontWeight:700 }}>{pCfg[1]}</span>
                  <span style={{ color:C.success, fontSize:11, fontWeight:600 }}>✓ Submitted</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Search + request side by side */}
      <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:20, flexWrap:"wrap" }}>
        <input
          placeholder="Search integrations..."
          value={search} onChange={e=>setSearch(e.target.value)}
          style={{ background:C.surfaceHigh, border:`1px solid ${C.border}`, color:C.text, borderRadius:8, padding:"9px 14px", fontSize:13, flex:"1 1 200px", maxWidth:340, fontFamily:"inherit", outline:"none" }}
        />
        <div style={{ color:C.textDim, fontSize:12 }}>
          Can't find what you need?{" "}
          <button onClick={()=>setShowReqModal(true)} style={{ background:"none", border:"none", color:C.accent, fontSize:12, fontWeight:600, cursor:"pointer", padding:0, textDecoration:"underline" }}>
            Request it here
          </button>
        </div>
      </div>

      {/* Integration cards by category */}
      <div style={{ display:"flex", flexDirection:"column", gap:24 }}>
        {filtered.map(cat=>(
          <div key={cat.category}>
            <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.09em", fontWeight:700, marginBottom:12, paddingBottom:6, borderBottom:`1px solid ${C.border}` }}>
              {cat.category}
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(260px, 1fr))", gap:10 }}>
              {cat.tools.map(tool=>{
                const isConnected  = !!connected[tool.id];
                const isComingSoon = tool.status==="coming";
                return (
                  <div key={tool.id} style={{ background:C.surface, border:`1px solid ${isConnected?C.accent:C.border}`, borderRadius:11, padding:"16px", transition:"all 0.15s", opacity:isComingSoon?0.72:1 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
                      <span style={{ fontSize:22 }}>{tool.icon}</span>
                      <div>
                        <div style={{ color:C.text, fontWeight:700, fontSize:13 }}>{tool.name}</div>
                        {isComingSoon && <span style={{ background:C.warnSoft, color:C.warn, border:`1px solid ${C.warn}44`, borderRadius:4, padding:"1px 6px", fontSize:9, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.06em" }}>Coming Soon</span>}
                        {isConnected  && <span style={{ background:C.successSoft, color:C.success, border:`1px solid ${C.success}44`, borderRadius:4, padding:"1px 6px", fontSize:9, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.06em" }}>Connected</span>}
                      </div>
                    </div>
                    <div style={{ color:C.textDim, fontSize:12, lineHeight:1.6, marginBottom:14 }}>{tool.desc}</div>
                    <div style={{ display:"flex", gap:7 }}>
                      <button
                        onClick={()=>!isComingSoon&&handleConnect(tool.id, tool.name)}
                        style={{ flex:1, background:isComingSoon?C.surfaceHigh:isConnected?C.dangerSoft:C.accent, color:isComingSoon?C.textMuted:isConnected?C.danger:"#fff", border:isComingSoon?`1px solid ${C.border}`:isConnected?`1px solid ${C.danger}44`:"none", borderRadius:7, padding:"7px 10px", fontSize:12, fontWeight:600, cursor:isComingSoon?"not-allowed":"pointer", transition:"all 0.15s" }}>
                        {isComingSoon?"Notify Me":isConnected?"Disconnect":"Connect"}
                      </button>
                      {/* Per-card request button for coming soon tools */}
                      {isComingSoon && (
                        <button onClick={()=>setShowReqModal(true)} title="Request this integration" style={{ background:C.accentSoft, border:`1px solid ${C.accent}44`, color:C.accent, borderRadius:7, padding:"7px 10px", fontSize:12, fontWeight:600, cursor:"pointer", flexShrink:0, transition:"all 0.15s" }}>
                          +
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Bottom CTA banner — pitch closer */}
      <div style={{ marginTop:36, background:`linear-gradient(135deg, ${C.accent}18, ${C.purple}14)`, border:`1px solid ${C.accent}33`, borderRadius:14, padding:"24px 22px", display:"flex", alignItems:"center", gap:18, flexWrap:"wrap" }}>
        <div style={{ flex:1, minWidth:200 }}>
          <div style={{ fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:800, fontSize:16, color:C.text, marginBottom:5 }}>
            Using a tool that's not listed?
          </div>
          <div style={{ color:C.textDim, fontSize:13, lineHeight:1.65 }}>
            Clarix is built to plug into your existing stack — not replace it. Submit a request and our team will scope the integration and get back to you within 48 hours.
          </div>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:8, flexShrink:0 }}>
          <button onClick={()=>setShowReqModal(true)} style={{ background:C.accent, color:"#fff", border:"none", borderRadius:9, padding:"11px 24px", fontSize:13, fontWeight:700, cursor:"pointer", transition:"opacity 0.15s", whiteSpace:"nowrap" }}
            onMouseEnter={e=>e.target.style.opacity="0.85"} onMouseLeave={e=>e.target.style.opacity="1"}>
            Request Integration →
          </button>
          <div style={{ color:C.textDim, fontSize:11, textAlign:"center" }}>Response within 48 hours</div>
        </div>
      </div>
    </div>
  );
}

// ─── COLUMN MAPPING REVIEW PANEL ─────────────────────────────────────────────
const LOB_TYPE_LABELS = { call:"Call Operations", transport:"Transport & Attendance", docs:"Document Processing", scheduling:"Workforce Scheduling", unknown:"Unknown" };
const LOB_TYPE_COLORS = { call:"#6366f1", transport:"#10b981", docs:"#f59e0b", scheduling:"#06b6d4", unknown:"#6b6b9a" };

function ColumnMappingReview({ pendingLobs, onConfirm, onCancel, C }) {
  // pendingLobs: [{ name, data, csvText, lobType, mapping, fileName }]
  const [lobbies, setLobbies] = useState(pendingLobs.map(l=>({...l})));
  const S = GS2(C);

  const updateLobType = (idx, val) => setLobbies(prev=>{
    const n=[...prev]; n[idx]={...n[idx], lobType:val}; return n;
  });
  const updateMapping = (idx, slot, val) => setLobbies(prev=>{
    const n=[...prev]; n[idx]={...n[idx], mapping:{...n[idx].mapping, [slot]:val}}; return n;
  });

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.8)", zIndex:2000, display:"flex", alignItems:"flex-start", justifyContent:"center", padding:"24px 16px", overflowY:"auto" }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius:16, width:"100%", maxWidth:680, padding:26, animation:"fadeIn 0.2s ease" }}>
        {/* Header */}
        <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:6 }}>
          <div>
            <h3 style={{ margin:0, fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:800, fontSize:18, color:C.text }}>
              <span style={{ color:C.accent }}>◈ AI</span> Column Mapping
            </h3>
            <div style={{ color:C.textDim, fontSize:12, marginTop:3 }}>
              Review and adjust the AI-detected column mappings for your {lobbies.length} file{lobbies.length!==1?"s":""}. Override anything that looks wrong.
            </div>
          </div>
          <button onClick={onCancel} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:6, padding:"4px 10px", cursor:"pointer", fontSize:13, flexShrink:0 }}>✕</button>
        </div>

        <div style={{ borderTop:`1px solid ${C.border}`, margin:"16px 0" }}/>

        <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
          {lobbies.map((lob, idx)=>{
            const cols = lob.data.length>0 ? Object.keys(lob.data[0]) : [];
            const colOptions = [<option key="" value="">— not mapped —</option>, ...cols.map(c=><option key={c} value={c}>{c}</option>)];
            const tc = LOB_TYPE_COLORS[lob.lobType]||"#6b6b9a";
            const relevantSlots = MAPPING_SLOTS.filter(s=>s.lobTypes.includes(lob.lobType)||s.slot==="agentCol");

            return (
              <div key={idx} style={{ background:C.surfaceHigh, border:`1px solid ${tc}44`, borderRadius:12, padding:"16px 18px" }}>
                {/* File header */}
                <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14, flexWrap:"wrap" }}>
                  <div style={{ flex:1 }}>
                    <div style={{ color:C.text, fontWeight:700, fontSize:14 }}>{lob.name}</div>
                    <div style={{ color:C.textDim, fontSize:11, marginTop:2 }}>{lob.data.length} rows · {cols.length} columns</div>
                  </div>
                  {/* LOB type selector */}
                  <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                    <span style={{ color:C.textDim, fontSize:11 }}>Type:</span>
                    <select
                      value={lob.lobType}
                      onChange={e=>updateLobType(idx, e.target.value)}
                      style={{ background:C.surface, border:`1px solid ${tc}`, color:tc, borderRadius:7, padding:"5px 10px", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>
                      {Object.entries(LOB_TYPE_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                </div>

                {/* Cleaning report */}
                {lob.cleaningIssues && lob.cleaningIssues.length > 0 && (
                  <div style={{ marginBottom:12 }}>
                    <DataCleaningReport issues={lob.cleaningIssues} C={C}/>
                  </div>
                )}

                {lob.lobType==="unknown" ? (
                  <div style={{ background:C.warnSoft, border:`1px solid ${C.warn}44`, borderRadius:8, padding:"10px 13px", color:C.warn, fontSize:12 }}>
                    ⚠ Could not auto-detect the data type. Please select a type above to enable column mapping.
                  </div>
                ) : (
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:9 }}>
                    {relevantSlots.map(slot=>{
                      const currentVal = lob.mapping?.[slot.slot]||"";
                      const hasVal = !!currentVal;
                      return (
                        <div key={slot.slot}>
                          <label style={{ color:hasVal?C.success:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.07em", fontWeight:600, marginBottom:4, display:"flex", alignItems:"center", gap:5 }}>
                            {hasVal?"✓":slot.required?"*":"○"} {slot.label}
                          </label>
                          <select
                            value={currentVal}
                            onChange={e=>updateMapping(idx, slot.slot, e.target.value||null)}
                            style={{ background:C.surface, border:`1px solid ${hasVal?C.success+"66":C.border}`, color:hasVal?C.text:C.textDim, borderRadius:7, padding:"6px 9px", fontSize:12, cursor:"pointer", width:"100%", fontFamily:"inherit" }}>
                            {colOptions}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Preview: first 2 sample values for mapped columns */}
                {lob.lobType!=="unknown" && lob.data.length>0 && (()=>{
                  const mapped = relevantSlots.filter(s=>lob.mapping?.[s.slot]).slice(0,4);
                  if (mapped.length===0) return null;
                  return (
                    <div style={{ marginTop:12, background:C.surface, border:`1px solid ${C.border}`, borderRadius:8, padding:"9px 12px" }}>
                      <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.07em", fontWeight:600, marginBottom:7 }}>Sample values</div>
                      <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
                        {mapped.map(s=>{
                          const col = lob.mapping[s.slot];
                          const samples = lob.data.slice(0,2).map(r=>r[col]).filter(Boolean).join(", ");
                          return (
                            <div key={s.slot} style={{ background:C.surfaceHigh, borderRadius:6, padding:"4px 10px", fontSize:11 }}>
                              <span style={{ color:C.textDim }}>{s.label}: </span>
                              <span style={{ color:C.text, fontFamily:"monospace" }}>{samples||"—"}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>

        <div style={{ borderTop:`1px solid ${C.border}`, margin:"20px 0 0" }}/>
        <div style={{ display:"flex", gap:10, justifyContent:"flex-end", paddingTop:16 }}>
          <button onClick={onCancel} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:8, padding:"9px 18px", fontSize:13, cursor:"pointer" }}>Cancel</button>
          <button onClick={()=>onConfirm(lobbies)} style={{ background:C.accent, color:"#fff", border:"none", borderRadius:8, padding:"9px 22px", fontSize:13, fontWeight:700, cursor:"pointer" }}>
            Confirm & Load Data →
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [dark,      setDark]    = useState(false);
  const [role,      setRole]    = useState(null);   // null = login screen
  const [lobs,      setLobs]    = useState([]);
  const [active,    setActive]  = useState(null);
  const [sidebar,   setSidebar] = useState(true);
  const [memEvents, setMemEventsState] = useState([]);
  const [memLoaded, setMemLoaded]      = useState(false);
  const [mappingPending, setMappingPending] = useState(null); // files awaiting review
  const [mappingLoading, setMappingLoading] = useState(false); // spinner while AI maps
  const fileRef = useRef();
  const C = dark ? DARK : LIGHT;

  // Persistent memory
  useEffect(()=>{
    (async()=>{
      try {
        const r = await window.storage.get("clarix-memory-v3");
        const stored = r?JSON.parse(r.value):null;
        setMemEventsState(Array.isArray(stored)&&stored.length>0?stored:SEED_EVENTS);
      } catch { setMemEventsState(SEED_EVENTS); }
      setMemLoaded(true);
    })();
  },[]);

  const setMemEvents = useCallback(updater=>{
    setMemEventsState(prev=>{
      const next=typeof updater==="function"?updater(prev):updater;
      window.storage.set("clarix-memory-v3",JSON.stringify(next),false).catch(()=>{});
      return next;
    });
  },[]);

  const parseName = f=>f.replace(/\.csv$/i,"").replace(/[_\-]/g," ").replace(/\b\w/g,c=>c.toUpperCase());

  // Called when user confirms (or adjusts) the mapping review panel
  const confirmMapping = useCallback((reviewedLobs) => {
    setMappingPending(null);
    reviewedLobs.forEach(lob => {
      setLobs(prev=>prev.find(l=>l.name===lob.name)?prev:[...prev, lob]);
    });
    setActive(v=>v||"warnings");
  }, []);

  const addFiles = useCallback(files=>{
    const fileList = Array.from(files);
    // Read all files first, then run AI mapping on all at once
    const readAll = fileList.map(file => new Promise(resolve=>{
      const reader = new FileReader();
      reader.onload = e => {
        const res = Papa.parse(e.target.result, {header:true, skipEmptyLines:true});
        if (res.data?.length > 0) {
          resolve({ name:parseName(file.name), fileName:file.name, data:res.data, csvText:e.target.result });
        } else resolve(null);
      };
      reader.readAsText(file);
    }));

    Promise.all(readAll).then(async parsed => {
      const valid = parsed.filter(Boolean);
      if (valid.length === 0) return;

      // Run data cleaning on each file before AI mapping
      const cleaned = valid.map(lob => {
        const { data, issues } = cleanCSVData(lob.data, lob.fileName);
        return { ...lob, data, cleaningIssues: issues, csvText: data.length > 0
          ? [Object.keys(data[0]).join(","), ...data.map(r => Object.values(r).join(","))].join("\n")
          : lob.csvText };
      });

      setMappingLoading(true);
      // Run AI mapping on each cleaned file in parallel
      const withMappings = await Promise.all(cleaned.map(async lob => {
        try {
          const result = await detectColumnMapping(lob.csvText, lob.fileName);
          return { ...lob, lobType: result.lobType||"unknown", mapping: result.mapping||{} };
        } catch {
          return { ...lob, lobType:"unknown", mapping:{} };
        }
      }));
      setMappingLoading(false);
      setMappingPending(withMappings);
    });
  },[]);

  const loadSamples=()=>{
    const nl=Object.entries(SAMPLES).map(([fn,csv])=>{
      const res=Papa.parse(csv,{header:true,skipEmptyLines:true});
      const { data, issues } = cleanCSVData(res.data, fn);
      return{name:parseName(fn),data,csvText:csv,lobType:undefined,mapping:undefined,cleaningIssues:issues};
    });
    setLobs(nl); setActive("warnings");
  };

  // ── ROLE ACCESS CONTROL ──
  // Employee: can only see their own dept (first lob) or upload
  // Teamlead: can see all depts + their own
  // Director: can see everything
  const canSeeWarnings = role==="director"||role==="teamlead";
  const canSeeOverview = role==="director";
  const visibleLobs = role==="employee"?lobs.slice(0,1):lobs; // employees see first dept only
  const alerts = runEWE(visibleLobs);
  const critCount = alerts.filter(a=>a.severity==="CRITICAL").length;
  const curLob = visibleLobs.find(l=>l.name===active);
  const lobIdx = visibleLobs.findIndex(l=>l.name===active);
  const lobColor = LOB_COLORS[lobIdx%LOB_COLORS.length]||C.accent;

  // ── SHOW LOGIN ──
  if (!role) return <LoginScreen onLogin={setRole} dark={dark} setDark={setDark} C={C}/>;

  // ── EMPLOYEE: bypass upload entirely — show personal scorecard ──
  if (role==="employee") return <EmployeeScorecard onSignOut={()=>setRole(null)} dark={dark} setDark={setDark} C={C}/>;

  // ── SHOW UPLOAD ──
  if (lobs.length===0 && active!=="memory" && active!=="integrations") return (
    <>
      <UploadScreen role={role} onBack={()=>setRole(null)} onFilesLoaded={addFiles} onSamples={loadSamples} onMemory={()=>setActive("memory")} onIntegrations={()=>setActive("integrations")} dark={dark} setDark={setDark} memCount={memLoaded?memEvents.length:"..."} C={C}/>
      {/* AI mapping loading overlay */}
      {mappingLoading && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.75)", zIndex:3000, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16 }}>
          <div style={{ width:40, height:40, border:`3px solid #6366f130`, borderTop:`3px solid #6366f1`, borderRadius:"50%", animation:"spin 0.8s linear infinite" }}/>
          <div style={{ color:"#e6e6f4", fontWeight:600, fontSize:15 }}>◈ Cleaning & mapping your data…</div>
          <div style={{ color:"#686890", fontSize:13 }}>Auto-cleaning data, then detecting column roles</div>
        </div>
      )}
      {/* Mapping review panel */}
      {mappingPending && !mappingLoading && (
        <ColumnMappingReview pendingLobs={mappingPending} onConfirm={confirmMapping} onCancel={()=>setMappingPending(null)} C={C}/>
      )}
    </>
  );

  const Logo = ()=>(
    <span style={{ fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:800, fontSize:17, color:C.text }}>
      CLARIX<span style={{ background:C.accentSoft, color:C.accent, border:`1px solid ${C.accent}44`, borderRadius:4, padding:"2px 6px", fontSize:10, fontWeight:600, textTransform:"uppercase", marginLeft:8, verticalAlign:"middle" }}>Beta</span>
    </span>
  );

  // Main content renderer
  const renderContent = () => {
    if (active==="warnings" && canSeeWarnings)
      return <EarlyWarningPanel lobs={visibleLobs} C={C} onDeptClick={dept=>setActive(dept)} onBack={()=>setActive(null)}/>;
    if (active==="overview" && canSeeOverview)
      return <Overview lobs={lobs} C={C} onBack={()=>setActive(null)}/>;
    if (active==="teamdash" && canSeeWarnings)
      return <TeamPerformanceDashboard C={C} viewRole={role}/>
    if (active==="memory" && memLoaded)
      return <MemoryLayer events={memEvents} setEvents={setMemEvents} C={C} onBack={()=>{ setActive(lobs.length>0?"warnings":null); }}/>;
    if (active==="integrations")
      return <IntegrationsPage C={C} onBack={()=>setActive(null)}/>;
    if (curLob)
      return <LOBView key={`${curLob.name}-${role}-${curLob.data.length}`} lob={curLob} color={lobColor} role={role} C={C} onBack={()=>setActive(canSeeWarnings?"warnings":null)}/>;
    // Default: show dashboard home
    return (
      <div style={{ maxWidth:480, animation:"fadeIn 0.3s ease" }}>
        <h2 style={{ fontFamily:"'DM Serif Display',Georgia,serif", fontWeight:800, fontSize:22, marginBottom:6 }}>
          {role==="director"&&<>Good day, <span style={{ color:C.accent }}>Director.</span></>}
          {role==="teamlead"&&<>Good day, <span style={{ color:C.accent }}>Team Lead.</span></>}
          {role==="employee"&&<>Good day, <span style={{ color:C.accent }}>welcome.</span></>}
        </h2>
        <p style={{ color:C.textDim, fontSize:14, lineHeight:1.7, marginBottom:24 }}>
          {role==="director"&&"You have full access to all departments, warnings, and director overview."}
          {role==="teamlead"&&"You can view team alerts, department data, and the memory layer."}
          {role==="employee"&&"You can view your department data and the memory layer."}
        </p>
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {canSeeWarnings&&<button onClick={()=>setActive("warnings")} style={{ background:critCount>0?C.dangerSoft:C.surfaceHigh, border:`1px solid ${critCount>0?C.danger:C.border}`, borderRadius:10, padding:"14px 16px", cursor:"pointer", textAlign:"left", display:"flex", alignItems:"center", gap:10, transition:"all 0.15s" }}
            onMouseEnter={e=>{e.currentTarget.style.borderColor=C.accent;}} onMouseLeave={e=>{e.currentTarget.style.borderColor=critCount>0?C.danger:C.border;}}>
            <span style={{ fontSize:18 }}>⚡</span>
            <div style={{ flex:1 }}><div style={{ color:C.text, fontWeight:600, fontSize:13 }}>Early Warnings</div><div style={{ color:C.textDim, fontSize:12 }}>{critCount>0?`${critCount} critical alerts require attention`:"All metrics look normal"}</div></div>
            {critCount>0&&<span style={{ background:C.danger, color:"#fff", borderRadius:10, padding:"2px 8px", fontSize:11, fontWeight:700 }}>{critCount}</span>}
          </button>}
          {canSeeOverview&&<button onClick={()=>setActive("overview")} style={{ background:C.surfaceHigh, border:`1px solid ${C.border}`, borderRadius:10, padding:"14px 16px", cursor:"pointer", textAlign:"left", display:"flex", alignItems:"center", gap:10, transition:"all 0.15s" }}
            onMouseEnter={e=>{e.currentTarget.style.borderColor=C.accent;}} onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;}}>
            <span style={{ fontSize:18 }}>◈</span>
            <div><div style={{ color:C.text, fontWeight:600, fontSize:13 }}>Director Overview</div><div style={{ color:C.textDim, fontSize:12 }}>{lobs.length} departments · cross-team intelligence</div></div>
          </button>}
          {canSeeWarnings&&<button onClick={()=>setActive("teamdash")} style={{ background:C.accentSoft, border:`1px solid ${C.accent}44`, borderRadius:10, padding:"14px 16px", cursor:"pointer", textAlign:"left", display:"flex", alignItems:"center", gap:10, transition:"all 0.15s" }}
            onMouseEnter={e=>{e.currentTarget.style.borderColor=C.accent;}} onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;}}>
            <span style={{ fontSize:18 }}>◉</span>
            <div><div style={{ color:C.accent, fontWeight:600, fontSize:13 }}>Team Performance Dashboard</div><div style={{ color:C.textDim, fontSize:12 }}>{TEAM_MEMBERS.length} members · monthly scorecard · PKT monthly</div></div>
          </button>}
          {visibleLobs.map((lob,i)=>{
            const color=LOB_COLORS[i%LOB_COLORS.length];
            const m=computeMetrics(lob.data,lob.name,lob.mapping,lob.lobType);
            return <button key={lob.name} onClick={()=>setActive(lob.name)} style={{ background:C.surfaceHigh, border:`1px solid ${C.border}`, borderRadius:10, padding:"14px 16px", cursor:"pointer", textAlign:"left", display:"flex", alignItems:"center", gap:10, transition:"all 0.15s" }}
              onMouseEnter={e=>{e.currentTarget.style.borderColor=color;}} onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;}}>
              <span style={{ width:10, height:10, borderRadius:"50%", background:color, flexShrink:0 }}/>
              <div style={{ flex:1 }}><div style={{ color:C.text, fontWeight:600, fontSize:13 }}>{lob.name}</div><div style={{ color:C.textDim, fontSize:12 }}>{lob.data.length} records</div></div>
              <RiskBadge level={m._risk} C={C}/>
            </button>;
          })}
          <button onClick={()=>setActive("memory")} style={{ background:C.purpleSoft, border:`1px solid ${C.purple}44`, borderRadius:10, padding:"14px 16px", cursor:"pointer", textAlign:"left", display:"flex", alignItems:"center", gap:10 }}>
            <span style={{ fontSize:18 }}>◎</span>
            <div><div style={{ color:C.purple, fontWeight:600, fontSize:13 }}>Memory Layer</div><div style={{ color:C.textDim, fontSize:12 }}>{memLoaded?memEvents.length:"..."} institutional events</div></div>
          </button>
          <button onClick={()=>setActive("integrations")} style={{ background:C.surfaceHigh, border:`1px solid ${C.border}`, borderRadius:10, padding:"14px 16px", cursor:"pointer", textAlign:"left", display:"flex", alignItems:"center", gap:10, transition:"all 0.15s" }}
            onMouseEnter={e=>{e.currentTarget.style.borderColor=C.accent;}} onMouseLeave={e=>{e.currentTarget.style.borderColor=C.border;}}>
            <span style={{ fontSize:18 }}>⚡</span>
            <div><div style={{ color:C.text, fontWeight:600, fontSize:13 }}>Integrations</div><div style={{ color:C.textDim, fontSize:12 }}>Connect Zendesk, Slack, Genesys & more</div></div>
          </button>
        </div>
        <div style={{ marginTop:16 }}>
          <button onClick={()=>fileRef.current?.click()} style={{ background:"transparent", border:`1px dashed ${C.border}`, color:C.textDim, borderRadius:8, padding:"8px 14px", fontSize:12, cursor:"pointer" }}>+ Add more departments</button>
          <input ref={fileRef} type="file" accept=".csv" multiple style={{ display:"none" }} onChange={e=>addFiles(e.target.files)}/>
        </div>
      </div>
    );
  };

  return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.text, fontFamily:"'Inter',sans-serif", display:"flex", flexDirection:"column" }}>
      <style>{GS}</style>

      {/* AI mapping loading overlay — shown when processing uploaded files */}
      {mappingLoading && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.78)", zIndex:3000, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16 }}>
          <div style={{ width:40, height:40, border:`3px solid #6366f130`, borderTop:`3px solid #6366f1`, borderRadius:"50%", animation:"spin 0.8s linear infinite" }}/>
          <div style={{ color:"#e6e6f4", fontWeight:600, fontSize:15 }}>◈ Cleaning & mapping your data…</div>
          <div style={{ color:"#686890", fontSize:13 }}>Auto-cleaning data, then detecting column roles</div>
        </div>
      )}
      {/* Mapping review panel */}
      {mappingPending && !mappingLoading && (
        <ColumnMappingReview pendingLobs={mappingPending} onConfirm={confirmMapping} onCancel={()=>setMappingPending(null)} C={C}/>
      )}
      <nav style={{ borderBottom:`1px solid ${C.border}`, background:C.surface, padding:"0 16px", height:52, display:"flex", alignItems:"center", justifyContent:"space-between", flexShrink:0, position:"sticky", top:0, zIndex:100 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <button onClick={()=>setSidebar(!sidebar)} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:6, padding:"4px 8px", cursor:"pointer", fontSize:14, lineHeight:1 }}>☰</button>
          <button onClick={()=>setActive(null)} style={{ background:"none", border:"none", cursor:"pointer", padding:0 }}><Logo/></button>
          {critCount>0&&<span style={{ background:C.dangerSoft, color:C.danger, border:`1px solid ${C.danger}44`, borderRadius:20, padding:"2px 9px", fontSize:11, fontWeight:700, animation:"pulse 2s infinite" }}>🚨 {critCount} Critical</span>}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:7 }}>
          <span style={{ color:C.textDim, fontSize:12 }}>{ACCOUNTS[role]?.icon} {ACCOUNTS[role]?.label}</span>
          <button onClick={()=>{ setLobs([]); setActive(null); }} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:6, padding:"4px 9px", fontSize:11, cursor:"pointer" }}
            title="Go back to the upload screen">← Upload</button>
          <button onClick={()=>{ setLobs([]); setActive(null); setRole(null); }} style={{ background:"transparent", border:`1px solid ${C.border}`, color:C.textDim, borderRadius:6, padding:"4px 9px", fontSize:11, cursor:"pointer" }}>Sign Out</button>
          <button onClick={()=>setDark(!dark)} style={{ background:C.toggle, border:`1px solid ${C.border}`, borderRadius:20, padding:"5px 11px", fontSize:12, color:C.textDim, cursor:"pointer" }}>{dark?"☀":"☾"}</button>
        </div>
      </nav>

      <div style={{ display:"flex", flex:1 }}>
        {sidebar&&(
          <aside style={{ width:210, flexShrink:0, background:C.surface, borderRight:`1px solid ${C.border}`, padding:"13px 9px", overflowY:"auto", height:"calc(100vh - 52px)", position:"sticky", top:52 }}>
            <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:7, fontWeight:600, paddingLeft:3 }}>Home</div>
            <button onClick={()=>setActive(null)} style={{ width:"100%", textAlign:"left", background:active===null?C.accentSoft:"transparent", border:`1px solid ${active===null?C.accent:C.border}`, color:active===null?C.accent:C.textDim, borderRadius:7, padding:"7px 10px", fontSize:12, fontWeight:500, cursor:"pointer", marginBottom:4, transition:"all 0.15s" }}>🏠 Dashboard</button>

            {canSeeWarnings&&<button onClick={()=>setActive("warnings")} style={{ width:"100%", textAlign:"left", background:active==="warnings"?C.dangerSoft:"transparent", border:`1px solid ${active==="warnings"?C.danger:C.border}`, color:active==="warnings"?C.danger:C.textDim, borderRadius:7, padding:"7px 10px", fontSize:13, fontWeight:600, cursor:"pointer", marginBottom:4, transition:"all 0.15s", display:"flex", alignItems:"center", gap:7 }}>
              <span>⚡</span><span style={{ flex:1 }}>Early Warnings</span>
              {critCount>0&&<span style={{ background:C.danger, color:"#fff", borderRadius:10, padding:"1px 6px", fontSize:10, fontWeight:700 }}>{critCount}</span>}
            </button>}

            {canSeeOverview&&<button onClick={()=>setActive("overview")} style={{ width:"100%", textAlign:"left", background:active==="overview"?C.accentSoft:"transparent", border:`1px solid ${active==="overview"?C.accent:C.border}`, color:active==="overview"?C.accent:C.textDim, borderRadius:7, padding:"7px 10px", fontSize:13, fontWeight:600, cursor:"pointer", marginBottom:4, transition:"all 0.15s" }}>◈ Director Overview</button>}
            {canSeeWarnings&&<button onClick={()=>setActive("teamdash")} style={{ width:"100%", textAlign:"left", background:active==="teamdash"?C.accentSoft:"transparent", border:`1px solid ${active==="teamdash"?C.accent:C.border}`, color:active==="teamdash"?C.accent:C.textDim, borderRadius:7, padding:"7px 10px", fontSize:13, fontWeight:600, cursor:"pointer", marginBottom:4, transition:"all 0.15s" }}>◉ Team Performance</button>}

            {visibleLobs.length>0&&<>
              <div style={{ color:C.textDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:7, fontWeight:600, paddingLeft:3, marginTop:10 }}>Departments</div>
              {visibleLobs.map((lob,i)=>{
                const color=LOB_COLORS[i%LOB_COLORS.length];
                const isActive=active===lob.name;
                const m=computeMetrics(lob.data,lob.name,lob.mapping,lob.lobType);
                return <button key={lob.name} onClick={()=>setActive(lob.name)} style={{ width:"100%", textAlign:"left", background:isActive?`${color}18`:"transparent", border:`1px solid ${isActive?color:C.border}`, color:isActive?color:C.textDim, borderRadius:7, padding:"7px 10px", fontSize:12, fontWeight:500, cursor:"pointer", marginBottom:4, transition:"all 0.15s", display:"flex", alignItems:"center", gap:6 }}>
                  <span style={{ width:7, height:7, borderRadius:"50%", background:color, flexShrink:0 }}/>
                  <span style={{ flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{lob.name}</span>
                  {m._risk==="HIGH"&&<span style={{ color:C.danger, fontSize:11, fontWeight:800 }}>!</span>}
                </button>;
              })}
            </>}

            <div style={{ borderTop:`1px solid ${C.border}`, marginTop:9, paddingTop:9 }}>
              <button onClick={()=>setActive("memory")} style={{ width:"100%", textAlign:"left", background:active==="memory"?C.purpleSoft:"transparent", border:`1px solid ${active==="memory"?C.purple:C.border}`, color:active==="memory"?C.purple:C.textDim, borderRadius:7, padding:"7px 10px", fontSize:12, fontWeight:500, cursor:"pointer", marginBottom:8, transition:"all 0.15s", display:"flex", alignItems:"center", gap:7 }}>
                <span>◎</span><span style={{ flex:1 }}>Memory Layer</span>
                <span style={{ background:`${C.purple}33`, color:C.purple, borderRadius:9, padding:"1px 6px", fontSize:10, fontWeight:700 }}>{memLoaded?memEvents.length:"…"}</span>
              </button>
              <button onClick={()=>setActive("integrations")} style={{ width:"100%", textAlign:"left", background:active==="integrations"?C.accentSoft:"transparent", border:`1px solid ${active==="integrations"?C.accent:C.border}`, color:active==="integrations"?C.accent:C.textDim, borderRadius:7, padding:"7px 10px", fontSize:12, fontWeight:500, cursor:"pointer", marginBottom:8, transition:"all 0.15s", display:"flex", alignItems:"center", gap:7 }}>
                <span>⚡</span><span style={{ flex:1 }}>Integrations</span>
              </button>
              {lobs.length>0&&<button onClick={()=>fileRef.current?.click()} style={{ width:"100%", background:"transparent", border:`1px dashed ${C.border}`, color:C.textDim, borderRadius:7, padding:"7px 10px", fontSize:12, cursor:"pointer" }}>+ Add files</button>}
              <input ref={fileRef} type="file" accept=".csv" multiple style={{ display:"none" }} onChange={e=>addFiles(e.target.files)}/>
            </div>
          </aside>
        )}

        <main style={{ flex:1, overflowY:"auto", padding:"24px" }}>
          {renderContent()}
        </main>
      </div>
    </div>
  );
}
