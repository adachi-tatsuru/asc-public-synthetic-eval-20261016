import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';

const fail=(code,message=code)=>{throw Object.assign(new Error(message),{code});};
const plain=value=>{
  if(value===null||typeof value!=='object'||Array.isArray(value))return false;
  const proto=Object.getPrototypeOf(value);return proto===Object.prototype||proto===null;
};
// Reads each own key exactly once from a data descriptor; rejects accessors, unknown, hidden and Symbol keys.
const fields=(value,keys,code='VALIDATION')=>{
  if(!plain(value))fail(code,'Expected a plain object');
  const own=Reflect.ownKeys(value);
  if(own.length!==keys.length||!own.every(key=>keys.includes(key)))fail(code,'Unexpected keys');
  const out={};
  for(const key of keys){
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor||!('value' in descriptor)||!descriptor.enumerable)fail(code,`Unsupported property ${key}`);
    out[key]=descriptor.value;
  }
  return out;
};
const text=value=>typeof value==='string'&&value.length>0;
const int=(value,min)=>Number.isSafeInteger(value)&&value>=min;
const check=(ok,message)=>{if(!ok)fail('VALIDATION',message);};
const actorOf=actor=>{
  const {tenant,role}=fields(actor,['tenant','role'],'AUTH');
  if(!text(tenant)||(role!=='admin'&&role!=='reader'))fail('AUTH','Invalid actor');
  return {tenant,role};
};
const writer=actor=>{if(actor.role!=='admin')fail('FORBIDDEN','Readers may not mutate');};
const publicInvoice=row=>({id:row.id,tenant:row.tenant,reservationId:row.reservation_id,amountCents:row.amount_cents,status:row.status,version:row.version});

export class BillingService {
  #db;
  constructor(filename) {
    this.#db=new DatabaseSync(filename);
    this.#db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS billing_invoices(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,tenant TEXT NOT NULL,
        reservation_id TEXT NOT NULL,amount_cents INTEGER NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,UNIQUE(tenant,reservation_id));
      CREATE TABLE IF NOT EXISTS billing_idempotency(tenant TEXT NOT NULL,operation TEXT NOT NULL,key TEXT NOT NULL,
        input TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(tenant,operation,key));`);
  }
  close() { if(this.#db.isOpen)this.#db.close(); }
  #transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try{const result=fn();this.#db.exec('COMMIT');return result;}
    catch(error){if(this.#db.isTransaction)this.#db.exec('ROLLBACK');throw error;}
  }
  #idempotent(actor,operation,key,input,fn) {
    const canonical=JSON.stringify(input);
    return structuredClone(this.#transaction(()=>{
      const prior=this.#db.prepare('SELECT input,result FROM billing_idempotency WHERE tenant=? AND operation=? AND key=?').get(actor.tenant,operation,key);
      if(prior){if(prior.input!==canonical)fail('CONFLICT','Idempotency key reused with different input');return JSON.parse(prior.result);}
      const result=fn();
      this.#db.prepare('INSERT INTO billing_idempotency(tenant,operation,key,input,result) VALUES(?,?,?,?,?)').run(actor.tenant,operation,key,canonical,JSON.stringify(result));
      return result;
    }));
  }
  #row(tenant,id) { return this.#db.prepare('SELECT * FROM billing_invoices WHERE tenant=? AND id=?').get(tenant,id); }
  issue(actor, input) {
    actor=actorOf(actor);
    const {key,event:raw}=fields(input,['key','event']);check(text(key),'Invalid key');
    const {currency,...event}=fields(raw,['id','tenant','sku','quantity','amountCents','status','version','currency']);
    check(currency==='JPY','Unsupported currency');
    check(text(event.id)&&text(event.tenant)&&text(event.sku),'Invalid event identifiers');
    check(int(event.quantity,1)&&int(event.amountCents,0)&&int(event.version,1),'Invalid event numbers');
    check(event.status==='reserved','Event must be reserved');
    writer(actor);
    if(event.tenant!==actor.tenant)fail('FORBIDDEN','Event tenant mismatch');
    // currency is the constant 'JPY' and is excluded so the canonical input stays byte-identical to pre-revision records.
    return this.#idempotent(actor,'issue',key,{event},()=>{
      if(this.#db.prepare('SELECT 1 FROM billing_invoices WHERE tenant=? AND reservation_id=?').get(actor.tenant,event.id))fail('CONFLICT','Reservation already invoiced');
      const invoice={id:randomUUID(),tenant:actor.tenant,reservationId:event.id,amountCents:event.amountCents,status:'open',version:1};
      this.#db.prepare('INSERT INTO billing_invoices(id,tenant,reservation_id,amount_cents,status,version) VALUES(?,?,?,?,?,?)')
        .run(invoice.id,invoice.tenant,invoice.reservationId,invoice.amountCents,invoice.status,invoice.version);
      return invoice;
    });
  }
  #transition(operation,from,to,actor,input) {
    actor=actorOf(actor);
    const {key,id,expectedVersion}=fields(input,['key','id','expectedVersion']);
    check(text(key)&&text(id)&&int(expectedVersion,1),'Invalid transition input');
    writer(actor);
    return this.#idempotent(actor,operation,key,{id,expectedVersion},()=>{
      const row=this.#row(actor.tenant,id);if(!row)fail('NOT_FOUND','Invoice not found');
      if(row.version!==expectedVersion)fail('CONFLICT','Stale version');
      if(row.status!==from)fail('CONFLICT',`Invoice is ${row.status}`);
      this.#db.prepare('UPDATE billing_invoices SET status=?,version=version+1 WHERE seq=?').run(to,row.seq);
      return publicInvoice(this.#db.prepare('SELECT * FROM billing_invoices WHERE seq=?').get(row.seq));
    });
  }
  pay(actor, input) { return this.#transition('pay','open','paid',actor,input); }
  refund(actor, input) { return this.#transition('refund','paid','refunded',actor,input); }
  get(actor, id) {
    actor=actorOf(actor);check(text(id),'Invalid id');
    const row=this.#row(actor.tenant,id);if(!row)fail('NOT_FOUND','Invoice not found');
    return publicInvoice(row);
  }
  list(actor, query) {
    actor=actorOf(actor);
    const {page,pageSize}=fields(query,['page','pageSize']);
    check(int(page,1)&&int(pageSize,1)&&pageSize<=50,'Invalid pagination');
    const {total}=this.#db.prepare('SELECT COUNT(*) AS total FROM billing_invoices WHERE tenant=?').get(actor.tenant);
    const offset=(page-1)*pageSize;
    const items=Number.isSafeInteger(offset)&&offset<total
      ?this.#db.prepare('SELECT * FROM billing_invoices WHERE tenant=? ORDER BY seq LIMIT ? OFFSET ?').all(actor.tenant,pageSize,offset).map(publicInvoice):[];
    return {items,total};
  }
}
