"use strict";
const WEEK = 7 * 24 * 60 * 60 * 1000;
function timestamp(raw) {
  raw=String(raw||'');
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(raw)?raw:raw+'+08:00');
}

function requiresChoice(event, enabled) {
  return enabled === true && event && event.activity_type === "class_meeting" &&
    Boolean(event.event_group_id) && ["MORNING", "AFTERNOON"].includes(event.session_code);
}

function deadline(event) {
  const raw=String(event.scheduled_end_at || "");
  const end=timestamp(raw);
  if(event.session_code!=="KONPA"||!Number.isFinite(end)) throw new Error("KONPA_END_REQUIRED");
  return new Date(end+WEEK).toISOString();
}

function choicePatch(event, choice, konpaEvent, now) {
  if(typeof choice!=="boolean")throw new Error("请选择是否参加空巴");
  if(!["MORNING","AFTERNOON"].includes(event.session_code))throw new Error("KONPA_SESSION_INVALID");
  if(!konpaEvent||konpaEvent.event_group_id!==event.event_group_id||konpaEvent.class_org_unit_id!==event.class_org_unit_id)
    throw new Error("KONPA_SESSION_INVALID");
  const patch={konpa_choice:choice,konpa_choice_at:new Date(now).toISOString(),konpa_event_id:konpaEvent.event_id,
    konpa_group_id:event.event_group_id,konpa_class_id:event.class_org_unit_id};
  if(event.session_code==="AFTERNOON") Object.assign(patch,{konpa_review:choice?"PENDING":"DECLINED",konpa_due_at:deadline(konpaEvent)});
  return patch;
}

function automaticDue(row, now) {
  return row.konpa_choice===true && row.konpa_review==="PENDING" &&
    Number.isFinite(Date.parse(row.konpa_due_at)) && Date.parse(row.konpa_due_at)<=now;
}
module.exports={requiresChoice,deadline,choicePatch,automaticDue,timestamp};
