"use strict";
const crypto=require('crypto');
const {documentData,requireDatabaseSuccess,checkinDocumentId}=require('./platform-service');
const policy=require('./konpa-policy');
const key=(event,id)=>'konpa_'+crypto.createHash('sha256').update(event+'\x1f'+id).digest('hex').slice(0,48);
const one=async(db,name,id)=>documentData(await db.collection(name).doc(id).get());
const id=e=>String(e.event_id||e._id||'');
function memberKey(r){return r.platform_member_id?'id:'+r.platform_member_id:r.member_code?'code:'+r.member_code:'';}
function sourceFor(reg,sources){const identity=memberKey(reg);const matched=sources.filter(r=>identity&&memberKey(r)===identity);return matched.length===1?matched[0]:null;}
function rowState(review,source,checked){
 if(review)return review;
 if(checked&&!checked.konpa_voided)return {status:'CONFIRMED',choice:true,revision:'existing'};
 return {status:source&&source.konpa_choice===true?'PENDING':'UNCONFIRMED',choice:source?source.konpa_choice:null,revision:'initial'};
}
async function reviewRequest({db,event,events,registrations,checkins,payload,actor,deliver,now=Date.now()}){
 if(event.session_code!=='KONPA'||event.activity_type!=='class_meeting'||event.lifecycle_status!=='CONFIRMED')throw Error('空巴场次未确认或已取消');
 if(!actor||!actor.classes.includes(event.class_org_unit_id))throw Error('无此班级权限');
 const rows=registrations.filter(r=>String(r.batch_id)===id(event));
 const afternoonIds=new Set(events.filter(e=>e.event_group_id===event.event_group_id&&e.session_code==='AFTERNOON').map(id));
 const morningIds=new Set(events.filter(e=>e.event_group_id===event.event_group_id&&e.session_code==='MORNING').map(id));
 const afternoon=checkins.filter(r=>afternoonIds.has(String(r.batch_id))&&typeof r.konpa_choice==='boolean');
 const morning=checkins.filter(r=>morningIds.has(String(r.batch_id))&&typeof r.konpa_choice==='boolean');
 const permitted=rows.filter(r=>actor.members===null||actor.members.includes(String(r.platform_member_id||'')));
 if(payload.action==='list'||payload.action==='dinner_lock'){
  const output=[];
  for(const reg of permitted){
   const review=await one(db,'config',key(id(event),reg._id));
   const source=sourceFor(reg,afternoon), am=sourceFor(reg,morning);
   const checked=checkins.find(r=>String(r.batch_id)===id(event)&&String(r.registration_id)===String(reg._id));
   const state=rowState(review,source,checked);
   output.push({registration_id:reg._id,name:reg.name,group_name:reg.group_name,member_code:reg.member_code,
    morning_choice:am?am.konpa_choice:null,afternoon_choice:source?source.konpa_choice:null,
    latest_choice:state.choice===null?(am?am.konpa_choice:null):state.choice,
    status:state.status,choice:state.choice,revision:state.revision,confirmed_by:state.confirmed_by||null});
  }
  let dinner=await one(db,'config',key(id(event),'dinner'));
  if(payload.action==='dinner_lock'){
   if(!actor.manage||actor.members!==null)throw Error('无订餐锁定权限');
   dinner=await db.runTransaction(async tx=>{
    const doc=tx.collection('config').doc(key(id(event),'dinner'));
    const previous=await one(tx,'config',key(id(event),'dinner'));if(previous)return previous;
    const snapshot={registration_ids:output.filter(r=>r.latest_choice===true).map(r=>r.registration_id),locked_at:new Date(now).toISOString(),locked_by:actor.id};
    requireDatabaseSuccess(await doc.set(snapshot));
    requireDatabaseSuccess(await tx.collection('event_audit_logs').doc('konpa_'+crypto.randomBytes(20).toString('hex')).set({event_id:id(event),action:'konpa.dinner_lock',actor_id:actor.id,count:snapshot.registration_ids.length,created_at:snapshot.locked_at}));
    return snapshot;
   });
  }
  const lockedIds=new Set(dinner?dinner.registration_ids:[]);
  const locked=output.filter(r=>lockedIds.has(r.registration_id));
  return {rows:output,can_manage:actor.manage,auto_confirm_at:policy.deadline(event),
   dinner_locked_at:dinner?dinner.locked_at:null,dinner_locked_count:dinner?locked.length:null,
   dinner_added:dinner?output.filter(r=>r.latest_choice===true&&!lockedIds.has(r.registration_id)).length:null,
   dinner_removed:dinner?locked.filter(r=>r.latest_choice!==true).length:null,
   estimated_count:output.filter(r=>r.latest_choice===true).length,confirmed_count:output.filter(r=>r.status==='CONFIRMED').length};
 }
 if(!actor.manage||actor.members!==null)throw Error('无修改或确认权限');
 const reg=permitted.find(r=>String(r._id)===String(payload.registration_id));
 if(!reg)throw Error('报名不在授权场次范围');
 if(!['set','confirm','auto'].includes(payload.action))throw Error('操作无效');
 const source=sourceFor(reg,afternoon);
 let saved=null;
 const result=await db.runTransaction(async tx=>{
  const liveEvent=await one(tx,'events',event._id);
  const liveReg=await one(tx,'registrations',reg._id);
  if(!liveEvent||liveEvent.lifecycle_status!=='CONFIRMED'||!liveReg||String(liveReg.batch_id)!==id(event))throw Error('活动或报名已变化');
  const reviewDoc=tx.collection('config').doc(key(id(event),reg._id));
  const existing=await one(tx,'config',key(id(event),reg._id));
  const attendanceId=checkinDocumentId(id(event),reg._id);
  const checked=await one(tx,'checkins',attendanceId);
  const liveSource=source?await one(tx,'checkins',source._id):null;
  const state=rowState(existing,liveSource,checked);
  if(payload.action==='auto'){
   if(checked&&!existing&&liveSource)requireDatabaseSuccess(await tx.collection('checkins').doc(source._id).update({konpa_review:'CONFIRMED'}));
   if(checked&&!existing||existing&&!['PENDING','REVIEWED'].includes(existing.status)||now<Date.parse(policy.deadline(event))||!liveSource&&!existing)return {skipped:true};
  }else if(payload.expected_revision!==state.revision)throw Error('记录已变化，请刷新后重试');
  const choice=payload.action==='set'?payload.choice:state.choice;
  if(typeof choice!=='boolean')throw Error('请明确是否参加');
  const finalize=payload.action!=='set';
  if(finalize&&(!Number.isFinite(policy.timestamp(event.scheduled_start_at))||now<policy.timestamp(event.scheduled_start_at)))throw Error('空巴尚未开始或时间未确认');
  const updated={kind:'KONPA_REVIEW',auto_confirm_at:policy.deadline(event),event_id:id(event),registration_id:reg._id,choice,status:finalize?(choice?'CONFIRMED':'ABSENT'):'REVIEWED',
   revision:crypto.randomBytes(16).toString('hex'),updated_at:new Date(now).toISOString(),actor_id:actor.id,
   confirmed_by:finalize?(payload.action==='auto'?'AUTO_AFTER_ONE_WEEK':'STAFF'):null};
  if(finalize){
   const revision=Math.max(Number(liveReg.konpa_source_revision||0),checked?2:1)+1;
   requireDatabaseSuccess(await tx.collection('registrations').doc(reg._id).update({konpa_source_revision:revision,konpa_updated_at:new Date(now).toISOString()}));
  }
  if(finalize&&choice&&!checked){
   const { _id, ...identity }=liveReg;
   const fact={...identity,registration_id:reg._id,batch_id:id(event),checked_at:new Date(policy.timestamp(event.scheduled_start_at)).toISOString(),
    checkin_source:payload.action==='auto'?'KONPA_AUTO_CONFIRM':'KONPA_STAFF_CONFIRM',confirmed_at:new Date(now).toISOString(),
    sync_state:'PENDING',sync_attempts:0,sync_next_retry_at:new Date(now).toISOString(),sync_last_error_code:''};
   requireDatabaseSuccess(await tx.collection('checkins').doc(attendanceId).set(fact));
   saved={...fact,_id:attendanceId};
  }
  if(finalize&&checked){
   const patch={konpa_voided:!choice,sync_state:'PENDING',sync_attempts:0,sync_next_retry_at:new Date(now).toISOString(),sync_last_error_code:'',confirmed_at:new Date(now).toISOString()};
   requireDatabaseSuccess(await tx.collection('checkins').doc(attendanceId).update(patch));saved={...checked,...patch,_id:attendanceId};
  }
  requireDatabaseSuccess(await reviewDoc.set(updated));
  if(finalize&&liveSource)requireDatabaseSuccess(await tx.collection('checkins').doc(source._id).update({konpa_review:updated.status}));
  requireDatabaseSuccess(await tx.collection('event_audit_logs').doc('konpa_'+crypto.randomBytes(20).toString('hex')).set({event_id:id(event),action:'konpa.'+payload.action,
   actor_id:actor.id,registration_id:reg._id,before_status:state.status,after_status:updated.status,
   before_choice:state.choice,after_choice:choice,created_at:new Date(now).toISOString()}));
  return {status:updated.status,revision:updated.revision};
 });
 if(saved&&deliver)await deliver(saved);
 return result;
}
module.exports={reviewRequest,sourceFor,rowState};
