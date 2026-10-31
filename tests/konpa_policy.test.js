const test=require('node:test');
const assert=require('node:assert/strict');
const p=require('../cloudfunc/konpa-policy');
const base={activity_type:'class_meeting',event_group_id:'meeting',class_org_unit_id:'class'};
const evening={...base,event_id:'evening',session_code:'KONPA',scheduled_end_at:'2026-10-31T20:30:00'};
test('Shanghai scheduled end plus seven days, exact deadline inclusive',()=>{
 const patch=p.choicePatch({...base,session_code:'AFTERNOON'},true,evening,0);
 assert.equal(patch.konpa_due_at,'2026-11-07T12:30:00.000Z');
 assert.equal(p.automaticDue(patch,Date.parse(patch.konpa_due_at)-1),false);
 assert.equal(p.automaticDue(patch,Date.parse(patch.konpa_due_at)),true);
 assert.equal(p.automaticDue({...patch,konpa_review:'ABSENT'},Date.parse(patch.konpa_due_at)+1),false);
});
test('explicit no is valid; missing or string choices cannot pass',()=>{
 const event={...base,session_code:'AFTERNOON'};
 assert.equal(p.choicePatch(event,false,evening,0).konpa_review,'DECLINED');
 for(const choice of [null,undefined,'false',0])assert.throws(()=>p.choicePatch(event,choice,evening,0));
 assert.throws(()=>p.choicePatch(event,true,{...evening,class_org_unit_id:'other'},0));
});
test('morning choice cannot turn into attendance, rollout stays opt-in',()=>{
 const event={...base,session_code:'MORNING'};
 assert.equal(p.choicePatch(event,true,evening,0).konpa_review,undefined);
 assert.equal(p.requiresChoice(event,false),false);
 assert.equal(p.requiresChoice(event,true),true);
 assert.equal(p.requiresChoice({...event,activity_type:'course'},true),false);
});
