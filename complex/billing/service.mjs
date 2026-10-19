import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const EVENT_KEYS=['amountCents','id','quantity','sku','status','tenant','version'];
const ISSUE_KEYS=['event','key'];
const TRANSITION_KEYS=['expectedVersion','id','key'];
const LIST_KEYS=['page','pageSize'];

function failure(code,message=code){
  const error=new Error(message);
  error.code=code;
  return error;
}

function hasExactKeys(value,expected){
  if(value===null||typeof value!=='object'||Array.isArray(value))return false;
  const keys=Reflect.ownKeys(value);
  return keys.length===expected.length&&keys.every(key=>typeof key==='string'&&expected.includes(key));
}

function nonemptyString(value){
  return typeof value==='string'&&value.length>0;
}

function boundedInteger(value,minimum){
  return Number.isSafeInteger(value)&&value>=minimum;
}

function validateActor(actor){
  if(actor===null||typeof actor!=='object'||!nonemptyString(actor.tenant)||(actor.role!=='admin'&&actor.role!=='reader')){
    throw failure('AUTH');
  }
}

function authorizeMutation(actor){
  validateActor(actor);
  if(actor.role!=='admin')throw failure('FORBIDDEN');
}

function validateKey(key){
  if(!nonemptyString(key))throw failure('VALIDATION');
}

function validateId(id){
  if(!nonemptyString(id))throw failure('VALIDATION');
}

function publicInvoice(row){
  return {
    id:row.id,
    tenant:row.tenant,
    reservationId:row.reservation_id,
    amountCents:row.amount_cents,
    status:row.status,
    version:row.version,
  };
}

export class BillingService {
  constructor(filename){
    this.db=new DatabaseSync(filename);
    this.closed=false;
    try{
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS billing_invoices (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          tenant TEXT NOT NULL,
          reservation_id TEXT NOT NULL,
          amount_cents INTEGER NOT NULL,
          status TEXT NOT NULL,
          version INTEGER NOT NULL,
          UNIQUE (tenant, reservation_id)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS billing_invoices_tenant_sequence
          ON billing_invoices (tenant, sequence);
        CREATE TABLE IF NOT EXISTS billing_idempotency (
          tenant TEXT NOT NULL,
          operation TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          canonical_input TEXT NOT NULL,
          result TEXT NOT NULL,
          PRIMARY KEY (tenant, operation, idempotency_key)
        ) STRICT;
      `);
    }catch(error){
      this.db.close();
      this.closed=true;
      throw error;
    }
  }

  close(){
    if(!this.closed){
      this.db.close();
      this.closed=true;
    }
  }

  issue(actor,input){
    authorizeMutation(actor);
    if(!hasExactKeys(input,ISSUE_KEYS))throw failure('VALIDATION');
    validateKey(input.key);
    const event=input.event;
    if(!hasExactKeys(event,EVENT_KEYS)||!nonemptyString(event.id)||!nonemptyString(event.tenant)||
      !nonemptyString(event.sku)||!boundedInteger(event.quantity,1)||!boundedInteger(event.amountCents,0)||
      event.status!=='reserved'||!boundedInteger(event.version,1)){
      throw failure('VALIDATION');
    }
    if(event.tenant!==actor.tenant)throw failure('FORBIDDEN');

    const canonical=JSON.stringify({event:{
      id:event.id,
      tenant:event.tenant,
      sku:event.sku,
      quantity:event.quantity,
      amountCents:event.amountCents,
      status:event.status,
      version:event.version,
    }});
    return this.transaction(()=>{
      const replay=this.replay(actor.tenant,'issue',input.key,canonical);
      if(replay!==undefined)return replay;
      const duplicate=this.db.prepare(`
        SELECT 1 FROM billing_invoices WHERE tenant=? AND reservation_id=?
      `).get(actor.tenant,event.id);
      if(duplicate)throw failure('CONFLICT');

      const result={
        id:randomUUID(),
        tenant:actor.tenant,
        reservationId:event.id,
        amountCents:event.amountCents,
        status:'open',
        version:1,
      };
      this.db.prepare(`
        INSERT INTO billing_invoices
          (id,tenant,reservation_id,amount_cents,status,version)
        VALUES (?,?,?,?,?,?)
      `).run(result.id,result.tenant,result.reservationId,result.amountCents,result.status,result.version);
      this.remember(actor.tenant,'issue',input.key,canonical,result);
      return {...result};
    });
  }

  pay(actor,input){
    return this.transition(actor,input,'pay','open','paid');
  }

  refund(actor,input){
    return this.transition(actor,input,'refund','paid','refunded');
  }

  get(actor,id){
    validateActor(actor);
    validateId(id);
    const row=this.db.prepare(`
      SELECT id,tenant,reservation_id,amount_cents,status,version
      FROM billing_invoices WHERE tenant=? AND id=?
    `).get(actor.tenant,id);
    if(!row)throw failure('NOT_FOUND');
    return publicInvoice(row);
  }

  list(actor,input){
    validateActor(actor);
    if(!hasExactKeys(input,LIST_KEYS)||!boundedInteger(input.page,1)||
      !boundedInteger(input.pageSize,1)||input.pageSize>50){
      throw failure('VALIDATION');
    }
    const count=this.db.prepare(`
      SELECT COUNT(*) AS total FROM billing_invoices WHERE tenant=?
    `).get(actor.tenant).total;
    const offset=(input.page-1)*input.pageSize;
    if(!Number.isSafeInteger(offset))return {items:[],total:count};
    const rows=this.db.prepare(`
      SELECT id,tenant,reservation_id,amount_cents,status,version
      FROM billing_invoices WHERE tenant=? ORDER BY sequence LIMIT ? OFFSET ?
    `).all(actor.tenant,input.pageSize,offset);
    return {items:rows.map(publicInvoice),total:count};
  }

  transition(actor,input,operation,fromStatus,toStatus){
    authorizeMutation(actor);
    if(!hasExactKeys(input,TRANSITION_KEYS))throw failure('VALIDATION');
    validateKey(input.key);
    validateId(input.id);
    if(!boundedInteger(input.expectedVersion,1))throw failure('VALIDATION');
    const canonical=JSON.stringify({id:input.id,expectedVersion:input.expectedVersion});
    return this.transaction(()=>{
      const replay=this.replay(actor.tenant,operation,input.key,canonical);
      if(replay!==undefined)return replay;
      const row=this.db.prepare(`
        SELECT id,tenant,reservation_id,amount_cents,status,version
        FROM billing_invoices WHERE tenant=? AND id=?
      `).get(actor.tenant,input.id);
      if(!row)throw failure('NOT_FOUND');
      if(row.status!==fromStatus||row.version!==input.expectedVersion)throw failure('CONFLICT');

      const version=row.version+1;
      if(!Number.isSafeInteger(version))throw failure('CONFLICT');
      this.db.prepare(`
        UPDATE billing_invoices SET status=?,version=? WHERE tenant=? AND id=?
      `).run(toStatus,version,actor.tenant,input.id);
      const result={...publicInvoice(row),status:toStatus,version};
      this.remember(actor.tenant,operation,input.key,canonical,result);
      return {...result};
    });
  }

  replay(tenant,operation,key,canonical){
    const row=this.db.prepare(`
      SELECT canonical_input,result FROM billing_idempotency
      WHERE tenant=? AND operation=? AND idempotency_key=?
    `).get(tenant,operation,key);
    if(!row)return undefined;
    if(row.canonical_input!==canonical)throw failure('CONFLICT');
    return JSON.parse(row.result);
  }

  remember(tenant,operation,key,canonical,result){
    this.db.prepare(`
      INSERT INTO billing_idempotency
        (tenant,operation,idempotency_key,canonical_input,result)
      VALUES (?,?,?,?,?)
    `).run(tenant,operation,key,canonical,JSON.stringify(result));
  }

  transaction(action){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const result=action();
      this.db.exec('COMMIT');
      return result;
    }catch(error){
      try{this.db.exec('ROLLBACK');}catch{}
      throw error;
    }
  }
}
