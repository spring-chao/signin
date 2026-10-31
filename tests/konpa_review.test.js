const test=require('node:test'),assert=require('node:assert/strict');
const {createAtomicDatabase}=require('./support/atomic_database');
const {reviewRequest}=require('../cloudfunc/konpa-review');
function fixture(){
 const event={_id:'ev-doc',event_id:'ev',activity_type:'class_meeting',session_code:'KONPA',event_group_id:'family',class_org_unit_id:'class',lifecycle_status:'CONFIRMED',scheduled_start_at:'2026-10-31T18:00',scheduled_end_at:'2026-10-31T20:30'};
 const afternoon={...event,_id:'pm-doc',event_id:'pm',session_code:'AFTERNOON'};
 const reg={_id:'registration',batch_id:'ev',name:'合成学员',platform_member_id:'123',member_code:'TEST123',phone:'PRIVATE-NEVER-RETURN'};
 const source={_id:'source',batch_id:'pm',platform_member_id:'123',konpa_choice:true,konpa_review:'PENDING',konpa_due_at:'2026-11-07T12:30:00.000Z'};
 const db=createAtomicDatabase({events:[event,afternoon],registrations:[reg],checkins:[source]});
 return {db,event,events:[event,afternoon],registrations:[reg],checkins:[source],actor:{id:'teacher',classes:['class'],members:null,manage:true},now:Date.parse('2026-11-07T12:30:00Z')};
}
test('concurrent automatic confirmations commit one evening fact and keep afternoon attendance separate',async()=>{
 const f=fixture();
 const results=await Promise.all([1,2].map(()=>reviewRequest({...f,payload:{action:'auto',registration_id:'registration'}})));
 assert.equal(results.filter(r=>r.skipped).length,1);
 assert.equal(f.db.collections.checkins.filter(r=>r.batch_id==='ev').length,1);
 assert.equal(f.db.collections.checkins.filter(r=>r.batch_id==='pm').length,1);
 assert.equal(f.db.collections.checkins.find(r=>r.batch_id==='ev').sync_state,'PENDING');
});
test('manual absence is preserved by the one-week automatic job',async()=>{
 const f=fixture();
 await reviewRequest({...f,payload:{action:'set',registration_id:'registration',expected_revision:'initial',choice:false}});
 await reviewRequest({...f,payload:{action:'auto',registration_id:'registration'}});
 assert.equal(f.db.collections.checkins.filter(r=>r.batch_id==='ev').length,0);
 assert.equal(f.db.collections.config[0].status,'ABSENT');
});
test('group viewers cannot write, other-class readers cannot read, private fields never leave list',async()=>{
 const f=fixture();
 await assert.rejects(()=>reviewRequest({...f,actor:{...f.actor,manage:false,members:['123']},payload:{action:'set',registration_id:'registration',choice:true}}));
 await assert.rejects(()=>reviewRequest({...f,actor:{...f.actor,classes:['other']},payload:{action:'list'}}));
 const result=await reviewRequest({...f,payload:{action:'list'}});
 assert.equal(JSON.stringify(result).includes('PRIVATE-NEVER-RETURN'),false);
 const hidden=await reviewRequest({...f,actor:{...f.actor,manage:false,members:['other']},payload:{action:'list'}});
 assert.equal(hidden.rows.length,0);
});
test('one millisecond before deadline stays pending; stale manual revisions reject',async()=>{
 const f=fixture();
 assert.equal((await reviewRequest({...f,now:f.now-1,payload:{action:'auto',registration_id:'registration'}})).skipped,true);
 await assert.rejects(()=>reviewRequest({...f,payload:{action:'set',registration_id:'registration',expected_revision:'stale',choice:false}}));
});
test('confirmed attendance can be corrected and restored without losing facts or reusing an old sync revision',async()=>{
 const f=fixture();
 let result=await reviewRequest({...f,payload:{action:'auto',registration_id:'registration'}});
 result=await reviewRequest({...f,payload:{action:'set',registration_id:'registration',expected_revision:result.revision,choice:false}});
 result=await reviewRequest({...f,payload:{action:'confirm',registration_id:'registration',expected_revision:result.revision}});
 assert.equal(result.status,'ABSENT');
 assert.equal(f.db.collections.checkins.find(r=>r.batch_id==='ev').konpa_voided,true);
 assert.equal(f.db.collections.registrations[0].konpa_source_revision,3);
 result=await reviewRequest({...f,payload:{action:'set',registration_id:'registration',expected_revision:result.revision,choice:true}});
 await reviewRequest({...f,payload:{action:'confirm',registration_id:'registration',expected_revision:result.revision}});
 assert.equal(f.db.collections.checkins.filter(r=>r.batch_id==='ev').length,1);
 assert.equal(f.db.collections.checkins.find(r=>r.batch_id==='ev').konpa_voided,false);
 assert.equal(f.db.collections.registrations[0].konpa_source_revision,4);
});
test('dinner snapshot stays fixed while later intent changes are reported separately',async()=>{
 const f=fixture();
 let result=await reviewRequest({...f,payload:{action:'dinner_lock'}});
 assert.equal(result.dinner_locked_count,1);
 await reviewRequest({...f,payload:{action:'set',registration_id:'registration',expected_revision:'initial',choice:false}});
 result=await reviewRequest({...f,payload:{action:'list'}});
 assert.equal(result.dinner_locked_count,1);assert.equal(result.dinner_removed,1);
});
