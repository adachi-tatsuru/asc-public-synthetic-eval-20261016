import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
const fail=(code,message=code)=>{throw Object.assign(new Error(message),{code});};
const isStr=v=>typeof v==='string'&&v.length>0;
const isInt=(v,min)=>Number.isSafeInteger(v)&&v>=min;
function snapshot(input,keys){
 if(input===null||typeof input!=='object'||Array.isArray(input))return null;
 const proto=Object.getPrototypeOf(input);if(proto!==Object.prototype&&proto!==null)return null;
 const own=Reflect.ownKeys(input);if(own.length!==keys.length)return null;
 const out={};
 for(const key of own){
  if(typeof key!=='string'||!keys.includes(key))return null;
  const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!('value' in d))return null;
  out[key]=d.value;
 }
 return out;
}
function fields(input,spec){
 const v=snapshot(input,Object.keys(spec));if(!v)fail('VALIDATION','Invalid input shape');
 for(const [k,check] of Object.entries(spec))if(!check(v[k]))fail('VALIDATION',`Invalid ${k}`);
 return v;
}
function actorOf(actor){
 const a=snapshot(actor,['tenant','role']);
 if(!a||!isStr(a.tenant)||(a.role!=='admin'&&a.role!=='reader'))fail('AUTH','Invalid actor');
 return a;
}
const admin=a=>{if(a.role!=='admin')fail('FORBIDDEN','Reader cannot mutate');};
const pub=r=>Object.freeze({id:r.id,tenant:r.tenant,sku:r.sku,quantity:r.quantity,amountCents:r.amountCents,status:r.status,version:r.version});
const row=r=>r&&pub({...r,amountCents:r.amount_cents});
const SELECT='SELECT id,tenant,sku,quantity,amount_cents,status,version FROM reservation_reservations';
export class ReservationService {
 #db;
 constructor(file){
  this.#db=new DatabaseSync(file,{timeout:10000});
  this.#db.exec('PRAGMA busy_timeout=10000');
  this.#tx(()=>this.#db.exec(`
   CREATE TABLE IF NOT EXISTS reservation_inventory(tenant TEXT NOT NULL,sku TEXT NOT NULL,available INTEGER NOT NULL,unit_cents INTEGER NOT NULL,PRIMARY KEY(tenant,sku));
   CREATE TABLE IF NOT EXISTS reservation_reservations(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,tenant TEXT NOT NULL,sku TEXT NOT NULL,quantity INTEGER NOT NULL,amount_cents INTEGER NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS reservation_idempotency(tenant TEXT NOT NULL,operation TEXT NOT NULL,key TEXT NOT NULL,input TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(tenant,operation,key));`));
 }
 #tx(fn,mode='IMMEDIATE'){
  this.#db.exec(`BEGIN ${mode}`);
  try{const r=fn();this.#db.exec('COMMIT');return r;}
  catch(e){if(this.#db.isTransaction)this.#db.exec('ROLLBACK');throw e;}
 }
 #idem(a,op,key,input,effect){
  const canonical=JSON.stringify(input);
  return this.#tx(()=>{
   const prior=this.#db.prepare('SELECT input,result FROM reservation_idempotency WHERE tenant=? AND operation=? AND key=?').get(a.tenant,op,key);
   if(prior){if(prior.input!==canonical)fail('CONFLICT','Idempotency key reused with different input');return pub(JSON.parse(prior.result));}
   const result=effect();
   this.#db.prepare('INSERT INTO reservation_idempotency(tenant,operation,key,input,result) VALUES(?,?,?,?,?)').run(a.tenant,op,key,canonical,JSON.stringify(result));
   return result;
  });
 }
 seed(actor,input){
  const a=actorOf(actor),v=fields(input,{sku:isStr,available:x=>isInt(x,0),unitCents:x=>isInt(x,0)});admin(a);
  this.#tx(()=>{
   if(this.#db.prepare('SELECT 1 FROM reservation_inventory WHERE tenant=? AND sku=?').get(a.tenant,v.sku))fail('CONFLICT','SKU exists');
   this.#db.prepare('INSERT INTO reservation_inventory(tenant,sku,available,unit_cents) VALUES(?,?,?,?)').run(a.tenant,v.sku,v.available,v.unitCents);
  });
 }
 reserve(actor,input){
  const a=actorOf(actor),v=fields(input,{key:isStr,sku:isStr,quantity:x=>isInt(x,1)});admin(a);
  return this.#idem(a,'reserve',v.key,[v.sku,v.quantity],()=>{
   const item=this.#db.prepare('SELECT available,unit_cents FROM reservation_inventory WHERE tenant=? AND sku=?').get(a.tenant,v.sku);
   if(!item)fail('NOT_FOUND','Unknown SKU');
   const amountCents=v.quantity*item.unit_cents;if(!Number.isSafeInteger(amountCents))fail('VALIDATION','Amount overflow');
   if(item.available<v.quantity)fail('CONFLICT','Insufficient inventory');
   this.#db.prepare('UPDATE reservation_inventory SET available=available-? WHERE tenant=? AND sku=?').run(v.quantity,a.tenant,v.sku);
   const r=pub({id:randomUUID(),tenant:a.tenant,sku:v.sku,quantity:v.quantity,amountCents,status:'reserved',version:1});
   this.#db.prepare('INSERT INTO reservation_reservations(id,tenant,sku,quantity,amount_cents,status,version) VALUES(?,?,?,?,?,?,?)').run(r.id,r.tenant,r.sku,r.quantity,r.amountCents,r.status,r.version);
   return r;
  });
 }
 cancel(actor,input){
  const a=actorOf(actor),v=fields(input,{key:isStr,id:isStr,expectedVersion:x=>isInt(x,1)});admin(a);
  return this.#idem(a,'cancel',v.key,[v.id,v.expectedVersion],()=>{
   const cur=row(this.#db.prepare(`${SELECT} WHERE tenant=? AND id=?`).get(a.tenant,v.id));
   if(!cur)fail('NOT_FOUND','Unknown reservation');
   if(cur.version!==v.expectedVersion)fail('CONFLICT','Stale version');
   if(cur.status!=='reserved')fail('CONFLICT','Not reserved');
   this.#db.prepare('UPDATE reservation_inventory SET available=available+? WHERE tenant=? AND sku=?').run(cur.quantity,a.tenant,cur.sku);
   this.#db.prepare("UPDATE reservation_reservations SET status='canceled',version=version+1 WHERE tenant=? AND id=?").run(a.tenant,v.id);
   return pub({...cur,status:'canceled',version:cur.version+1});
  });
 }
 inventory(actor,sku){
  const a=actorOf(actor);if(!isStr(sku))fail('VALIDATION','Invalid sku');
  const item=this.#db.prepare('SELECT sku,available,unit_cents FROM reservation_inventory WHERE tenant=? AND sku=?').get(a.tenant,sku);
  if(!item)fail('NOT_FOUND','Unknown SKU');
  return Object.freeze({sku:item.sku,available:item.available,unitCents:item.unit_cents});
 }
 get(actor,id){
  const a=actorOf(actor);if(!isStr(id))fail('VALIDATION','Invalid id');
  return row(this.#db.prepare(`${SELECT} WHERE tenant=? AND id=?`).get(a.tenant,id))??fail('NOT_FOUND','Unknown reservation');
 }
 list(actor,query){
  const a=actorOf(actor),v=fields(query,{page:x=>isInt(x,1),pageSize:x=>isInt(x,1)&&x<=50});
  return this.#tx(()=>{
   const {total}=this.#db.prepare('SELECT COUNT(*) AS total FROM reservation_reservations WHERE tenant=?').get(a.tenant);
   const offset=(v.page-1)*v.pageSize;
   const items=Number.isSafeInteger(offset)&&offset<total?this.#db.prepare(`${SELECT} WHERE tenant=? ORDER BY seq LIMIT ? OFFSET ?`).all(a.tenant,v.pageSize,offset).map(row):[];
   return {items,total};
  },'DEFERRED');
 }
 close(){if(this.#db.isOpen)this.#db.close();}
}
