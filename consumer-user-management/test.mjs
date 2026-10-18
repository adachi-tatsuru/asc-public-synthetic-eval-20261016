import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
test('synthetic API acceptance: persistence, validation and authorization',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'synthetic-users-'));
 const server=spawn(process.execPath,[new URL('./server.mjs',import.meta.url).pathname],{env:{...process.env,DATA_FILE:path.join(dir,'users.sqlite')},stdio:['ignore','pipe','inherit']});
 try{
  const output=await Promise.race([once(server.stdout,'data'),once(server,'exit').then(()=>{throw Error('server exited before ready');})]);
  const origin='http://127.0.0.1:'+JSON.parse(output[0]).port;
  const call=(method,route,body,session='dummy-admin')=>fetch(origin+route,{method,headers:{'content-type':'application/json',...(session?{'x-fixture-session':session}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  for(let i=1;i<=3;i++)assert.equal((await call('POST','/api/users',{name:'User '+i,email:'user'+i+'@example.test'})).status,201);
  assert.equal((await (await call('GET','/api/users?page=2')).json()).users.length,1);
  for(const email of ['a@@b.com','a@.com','a@b..com'])assert.equal((await call('POST','/api/users',{name:'bad',email})).status,400);
  assert.equal((await call('POST','/api/users',{name:'bad',email:'bad@example.test'},'dummy-reader')).status,403);
  assert.equal((await call('GET','/api/users',undefined,null)).status,401);
  assert.equal((await call('PUT','/api/users/1',{name:'Updated',email:'user1@example.test',version:1})).status,200);
  assert.equal((await call('PUT','/api/users/1',{name:'Stale',email:'user1@example.test',version:1})).status,409);
  assert.equal((await call('DELETE','/api/users/3')).status,200);
  const result=await (await call('GET','/api/users?page=2')).json();assert.equal(result.page,1);assert.equal(result.total,2);assert.equal(result.users[0].name,'Updated');
 }finally{const end=once(server,'exit');server.kill('SIGTERM');await end;fs.rmSync(dir,{recursive:true,force:true});}
});
