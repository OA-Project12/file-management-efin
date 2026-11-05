import { jpeg, fixturePdf } from './fixtures/file-bytes.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoader } from './helpers/load-typescript.mjs';
const load=createLoader();
const policy=load('src/domain/files/file-validation.ts');
const {validateStoredFile}=load('src/application/files/validate-stored-file.ts');
const {readObjectPrefix}=load('src/infrastructure/storage/read-object-prefix.ts');
const pdf=fixturePdf();
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=','base64');
const jpg=jpeg;

test('signature policy matches PDF/JPEG/PNG and case-insensitive declared types; empty browser MIME is inferred',()=>{
  for(const [name,mime,bytes] of [['report.PDF','APPLICATION/PDF',pdf],['photo.JPG','IMAGE/JPEG',jpg],['photo.jpeg','image/jpeg',jpg],['image.png','image/png',png]]) {
    assert.equal(policy.validateFilePrefix(name,mime,mime,bytes),mime.toLowerCase());
    assert.equal(policy.browserUploadMime({name,type:''}),mime.toLowerCase());
  }
  for(const bytes of [Buffer.alloc(0),Buffer.from('%PD'),Buffer.from([255,216]),Buffer.from('arbitrary text'),Buffer.from('GIF89a')])
    assert.throws(()=>policy.validateFilePrefix('a.pdf','application/pdf','application/pdf',bytes),{code:'file_signature_invalid'});
  assert.throws(()=>policy.validateFilePrefix('fake.pdf','application/pdf','application/pdf',png),{code:'file_type_mismatch'});
  assert.throws(()=>policy.validateFilePrefix('fake.pdf','application/pdf','image/png',pdf),{code:'file_type_mismatch'});
  for(const [name,type] of [['a.exe','application/pdf'],['a.pdf.exe','application/pdf'],['a.pdf','application/octet-stream'],['a.pdf','text/html']])
    assert.throws(()=>policy.validateDeclaredType(name,type),{code:'file_type_not_allowed'});
  assert.throws(()=>policy.validateDeclaredType('a.png','application/pdf'),{code:'file_type_mismatch'});
});
test('signature is a type hint, not a parser or malware verdict',()=>{
  assert.equal(policy.validateFilePrefix('header-only.pdf','application/pdf','application/pdf',Buffer.from('%PDF-')),'application/pdf');
});
test('stored-file validation binds size, MIME, ETag, version and timestamps; unavailable reads are not invalid files',async()=>{
  const before={sizeBytes:pdf.length,contentType:'application/pdf',eTag:'one',version:'one',lastModified:'one'};
  const storage={readObjectPrefix:async()=>pdf,getObjectInfo:async()=>before};
  assert.equal(await validateStoredFile(storage,'bucket','key','a.pdf','application/pdf',before),'application/pdf');
  for(const field of ['sizeBytes','contentType','eTag','version','lastModified'])
    await assert.rejects(validateStoredFile({...storage,getObjectInfo:async()=>({...before,[field]:field==='sizeBytes'?999:'changed'})},'b','k','a.pdf','application/pdf',before),{code:'object_changed'});
  await assert.rejects(validateStoredFile({...storage,readObjectPrefix:async()=>{throw Error('upstream');}},'b','k','a.pdf','application/pdf',before),{code:'file_validation_unavailable'});
  await assert.rejects(validateStoredFile({...storage,readObjectPrefix:async()=>pdf.subarray(0,6)},'b','k','a.pdf','application/pdf',before),{code:'file_validation_unavailable'});
});
test('prefix reader bounds memory and cancels range and ignored-range bodies; never follows redirects',async()=>{
  const original=globalThis.fetch;process.env.SUPABASE_URL='https://fixture.supabase.co';process.env.SUPABASE_SECRET_KEY='fixture-only';
  try{
    for(const status of [200,206]){
      let cancelled=false,signal;
      globalThis.fetch=async(url,init)=>{
        assert.equal(url.origin,'https://fixture.supabase.co');assert.equal(init.headers.Range,'bytes=0-1023');assert.equal(init.headers['If-Match'],'tag');assert.equal(init.redirect,'error');signal=init.signal;
        return new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(25000).fill(42));},cancel(){cancelled=true;}}),{status,headers:status===206?{'Content-Range':'bytes 0-1023/25000'}:{}});
      };
      const prefix=await readObjectPrefix('private-files','tenant/key',500,'tag');
      assert.equal(prefix.length,1024);assert.equal(cancelled,true);assert.equal(signal.aborted,true);
    }
    globalThis.fetch=async()=>new Response('bad',{status:412});
    await assert.rejects(readObjectPrefix('b','k'),{code:'object_changed'});
    globalThis.fetch=async()=>new Response('bad',{status:503});
    await assert.rejects(readObjectPrefix('b','k'),{code:'file_validation_unavailable'});
    globalThis.fetch=async()=>new Response('abc',{status:206,headers:{'Content-Range':'bytes 3-5/6'}});
    await assert.rejects(readObjectPrefix('b','k'),{code:'file_validation_unavailable'});
  }finally{globalThis.fetch=original;}
});
test('prefix deadline aborts stalled body reads and cancels the stream',async()=>{
  const original=globalThis.fetch;let cancelled=false,signal;
  globalThis.fetch=async(_url,init)=>{signal=init.signal;return new Response(new ReadableStream({cancel(){cancelled=true;}}));};
  try{await assert.rejects(readObjectPrefix('b','k',10),{code:'file_validation_unavailable'});assert.equal(signal.aborted,true);assert.equal(cancelled,true);}
  finally{globalThis.fetch=original;}
});
test('broken streams and transport failures fail closed without retries or raw upstream details',async()=>{
  const original=globalThis.fetch;let calls=0;
  try{
    globalThis.fetch=async()=>{calls++;return new Response(new ReadableStream({start(c){c.error(Error('fixture upstream detail'));}}));};
    await assert.rejects(readObjectPrefix('b','k'),{code:'file_validation_unavailable',message:'file_validation_unavailable'});assert.equal(calls,1);
    globalThis.fetch=async()=>{calls++;throw Error('fixture upstream detail');};
    await assert.rejects(readObjectPrefix('b','k'),{code:'file_validation_unavailable'});assert.equal(calls,2);
  }finally{globalThis.fetch=original;}
});
test('unsupported intent is rejected before any upload grant or reservation',async()=>{
  const {RequestFileUpload}=load('src/application/files/request-file-upload.ts');let calls=0;
  const usecase=new RequestFileUpload({createPendingUpload:async()=>{calls++;}},{createUploadGrant:async()=>{calls++;}});
  await assert.rejects(usecase.execute({originalName:'bad.exe',contentType:'application/pdf'}),{code:'file_type_not_allowed'});
  assert.equal(calls,0);
});

test('Storage adapter binds server metadata and signs uploads with upsert false',async()=>{
  let signingOptions;
  const adapterLoader=createLoader({'@supabase/supabase-js':{createClient:()=>({storage:{from:()=>({
    info:async()=>({data:{size:10,contentType:'image/png',etag:'tag',lastModified:'time',version:'version'},error:null}),
    createSignedUploadUrl:async(_key,options)=>{signingOptions=options;return{data:{signedUrl:'https://fixture.invalid/upload',token:'fixture-only'},error:null};},
  })}})}});
  process.env.SUPABASE_URL='https://fixture.supabase.co';process.env.SUPABASE_SECRET_KEY='fixture-only';process.env.STORAGE_BUCKET='private-files';
  const {SupabaseObjectStorage}=adapterLoader('src/infrastructure/storage/supabase-object-storage.ts');
  const storage=new SupabaseObjectStorage();assert.deepEqual(await storage.getObjectInfo('private-files','key'),{sizeBytes:10,contentType:'image/png',eTag:'tag',lastModified:'time',version:'version'});
  await storage.createUploadGrant('key');assert.deepEqual(signingOptions,{upsert:false});
});
