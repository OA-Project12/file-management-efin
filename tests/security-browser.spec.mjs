import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
// No live accounts or uploads. This suite validates browser-enforced CSP/hydration.
test('production login and invitation error render under CSP at desktop and mobile', async ({ browser }) => {
  for (const width of [1440,390]) {
    const page = await browser.newPage({ viewport: { width, height:900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__securityViolations = [];
      document.addEventListener('securitypolicyviolation', event => window.__securityViolations.push(event.violatedDirective));
    });
    const response = await page.goto('/');
    expect(response.headers()['x-frame-options']).toBe('DENY');
    expect(response.headers()['x-content-type-options']).toBe('nosniff');
    expect(response.headers()['content-security-policy']).not.toContain('unsafe-eval');
    await expect(page.getByLabel('อีเมล', { exact:true })).toBeVisible();
    await expect(page.getByRole('button', { name:'เข้าสู่ระบบ', exact:true })).toBeVisible();
    await page.goto('/set-password');
    await expect(page.getByText(/ลิงก์.*(?:เชิญ|หมดอายุ)|คำเชิญ.*(?:ใช้ไม่ได้|หมดอายุ)/).first()).toBeVisible();
    expect(await page.evaluate(() => window.__securityViolations)).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  }
});
test('security headers cover error routes and API responses', async ({ request }) => {
  for (const route of ['/missing-security-route', '/api/health/live', '/api/v1/me']) {
    const response = await request.get(route);
    expect(response.headers()['x-frame-options']).toBe('DENY');
    expect(response.headers()['referrer-policy']).toBe('no-referrer');
    expect(response.headers()['permissions-policy']).toContain('camera=()');
  }
});
test('actual Next.js POST body passes the guard and reaches authentication', async ({ request }) => {
  const response = await request.post('/api/v1/files/search', { data: {} });
  expect(response.status()).toBe(401);
  expect((await response.json()).error.code).toBe('unauthorized');
  expect(response.headers()['x-request-id']).toBeTruthy();
  expect(response.headers()['cache-control']).toBe('no-store');
});

function fixturePdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (let i=0;i<objects.length;i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i+1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
function fixturePng() {
  const width=240,height=100, pixels=Buffer.alloc((width*3+1)*height);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const i=y*(width*3+1)+1+x*3;
    const stripe=y<25 || (x>15 && x<220 && y>42 && y<55);
    pixels[i]=stripe?15:234; pixels[i+1]=stripe?118:245; pixels[i+2]=stripe?110:242;
  }
  const chunk=(name,data)=>{
    const label=Buffer.from(name), length=Buffer.alloc(4), checksum=Buffer.alloc(4);
    length.writeUInt32BE(data.length);checksum.writeUInt32BE(crc32(Buffer.concat([label,data])));
    return Buffer.concat([length,label,data,checksum]);
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
test('CSP permits text/image/PDF preview and download grants only for the configured origin', async ({ browser, baseURL }) => {
  const origin = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://fixture.supabase.co';
  const userId='77777777-7777-4777-8777-777777777777', dept='88888888-8888-4888-8888-888888888888', fileId='99999999-9999-4999-8999-999999999999';
  for (const [type,width] of [['text/plain',1440],['image/png',390],['application/pdf',1440]]) {
    const context = await browser.newContext({ viewport:{width,height:900} });
    const session={access_token:`${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({sub:userId,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.fixture`,refresh_token:'fixture',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user:{id:userId,email:'fixture@example.invalid',aud:'authenticated',app_metadata:{},user_metadata:{},created_at:'2026-01-01T00:00:00Z'}};
    await context.addInitScript(({ key, session })=>{
      localStorage.setItem(key,JSON.stringify(session)); window.__securityViolations=[];
      document.addEventListener('securitypolicyviolation',event=>window.__securityViolations.push(event.violatedDirective));
    },{key:`sb-${new URL(origin).hostname.split('.')[0]}-auth-token`,session});
    let previewRequests=0, downloadRequests=0;
    await context.route('**/auth/v1/**',route=>route.fulfill({json:session.user}));
    await context.route('**/api/v1/**',route=>{
      const path=new URL(route.request().url()).pathname;
      const ok=data=>route.fulfill({json:{data}});
      if(path.endsWith('/me')) return route.fulfill({json:{userId,tenantId:userId,applicationId:dept,isTenantAdmin:false,scopes:['files:read'],departments:[{id:dept,name:'IT',code:'it',role:'viewer'}]}});
      if(path.endsWith('/departments')) return ok({items:[{id:dept,name:'IT',code:'it',role:'viewer'}]});
      if(path.endsWith('/folders')) return ok({items:[]});
      if(path.endsWith('/search')) return ok({items:[{id:fileId,originalName:'CSP fixture',displayName:'CSP fixture',contentType:type,sizeBytes:'100',departmentId:dept,folderId:null,tags:[],createdAt:'2026-01-01T00:00:00Z'}],nextCursor:null});
      if(path.endsWith('/preview-url')) { previewRequests++; return ok({signedUrl:`${origin}/storage/v1/object/sign/fixture/preview?token=fixture`,contentType:type,expiresInSeconds:300}); }
      if(path.endsWith('/download-url')) { downloadRequests++; return ok({signedUrl:`${baseURL}/fixture-download`,contentType:type,expiresInSeconds:300}); }
      return route.fulfill({status:404,json:{error:{code:'fixture_not_found'}}});
    });
    await context.route(`${origin}/storage/**`,route=>route.fulfill({contentType:type,headers:{'Access-Control-Allow-Origin':new URL(baseURL).origin},body:type==='text/plain'?'CSP fixture <script>not executable</script>':type==='image/png'?fixturePng():fixturePdf()}));
    await context.route('**/fixture-download',route=>route.fulfill({contentType:'text/plain',body:'Synthetic download'}));
    const page=await context.newPage(); const errors=[]; page.on('pageerror',error=>errors.push(error.message));
    await page.goto('/'); await page.locator('.filename:visible').first().click();
    expect(previewRequests).toBe(0);
    const storageResponse=page.waitForResponse(response=>response.url().startsWith(`${origin}/storage/`));
    await page.getByRole('button',{name:'ดูตัวอย่าง',exact:true}).click();
    expect((await storageResponse).status()).toBe(200);
    if(type==='text/plain') await expect(page.locator('.text-preview')).toHaveText('CSP fixture <script>not executable</script>');
    if(type==='image/png') await expect.poll(()=>page.locator('.content-preview img').evaluate(img=>img.naturalWidth)).toBeGreaterThan(0);
    if(type==='application/pdf') await expect(page.locator('.content-preview iframe')).toHaveAttribute('src',`${origin}/storage/v1/object/sign/fixture/preview?token=fixture`);
    if (process.env.SECURITY_SCREENSHOT_DIR && type !== 'application/pdf') {
      mkdirSync(process.env.SECURITY_SCREENSHOT_DIR,{recursive:true});
      await page.screenshot({path:path.join(process.env.SECURITY_SCREENSHOT_DIR,`csp-preview-${width}.png`)});
    }
    const grant=page.waitForRequest(request=>new URL(request.url()).pathname.endsWith('/download-url'));
    await page.getByRole('button',{name:'ดาวน์โหลด',exact:true}).click(); await grant;
    expect(downloadRequests).toBe(1); expect(errors).toEqual([]);
    expect(await page.evaluate(()=>window.__securityViolations)).toEqual([]);
    await context.close();
  }
});

test('upload picker/drop validates types per file, infers blank MIME and distinguishes rejected versus unavailable completion', async ({ browser }) => {
  test.setTimeout(60_000);
  const origin=process.env.NEXT_PUBLIC_SUPABASE_URL??'https://fixture.supabase.co';
  const userId='77777777-7777-4777-8777-777777777777',dept='88888888-8888-4888-8888-888888888888';
  for(const width of [1440,390]){
    const context=await browser.newContext({viewport:{width,height:900}});
    const session={access_token:`${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({sub:userId,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.fixture`,refresh_token:'fixture',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user:{id:userId,email:'fixture@example.invalid',aud:'authenticated',app_metadata:{},user_metadata:{},created_at:'2026-01-01T00:00:00Z'}};
    await context.addInitScript(({key,session})=>localStorage.setItem(key,JSON.stringify(session)),{key:`sb-${new URL(origin).hostname.split('.')[0]}-auth-token`,session});
    await context.route('**/auth/v1/**',route=>route.fulfill({json:session.user}));
    let submitted=[],puts=[],completion='success';
    const polls=new Map();
    await context.route('**/api/v1/**',route=>{
      const path=new URL(route.request().url()).pathname,ok=data=>route.fulfill({json:{data}});
      if(path.endsWith('/me'))return route.fulfill({json:{userId,tenantId:userId,applicationId:dept,isTenantAdmin:false,scopes:['files:read','files:write'],departments:[{id:dept,name:'IT',code:'it',role:'editor'}]}});
      if(path.endsWith('/departments'))return ok({items:[{id:dept,name:'IT',code:'it',role:'editor'}]});
      if(path.endsWith('/folders'))return ok({items:[]});
      if(path.endsWith('/search'))return ok({items:[],nextCursor:null});
      if(path.endsWith('/upload-intents/batch')){
        submitted=route.request().postDataJSON().files;
        return ok({items:submitted.map((file,index)=>({index,status:'ready',fileId:`99999999-9999-4999-8999-${String(index+1).padStart(12,'0')}`,signedUrl:`${origin}/storage/v1/upload/${index}`}))});
      }
      if (path.endsWith('/complete') && completion === 'scan') {
        const scanId = path.split('/').at(-2).replace(/^99999999/, '77777777');
        return route.fulfill({status:202,json:{data:{scanId,status:'pending_scan',statusUrl:path.replace(/\/complete$/, '/scan-jobs/'+scanId)}}});
      }
      if(path.endsWith('/complete'))return completion==='success'?ok({status:'available'}):route.fulfill({status:completion==='invalid'?415:503,json:{error:{code:completion==='invalid'?'file_signature_invalid':'file_validation_unavailable'}}});
      if (path.includes('/scan-jobs/')) {
        const scanId=path.split('/').at(-1);
        const count=(polls.get(scanId)??0)+1;
        polls.set(scanId,count);
        const status=scanId.endsWith('2')?'quarantined':scanId.endsWith('3')?'scan_failed':'available';
        return ok({scanId,status:count === 1 ? 'scanning' : status});
      }
      return route.fulfill({status:404,json:{error:{code:'fixture_not_found'}}});
    });
    await context.route(`${origin}/storage/**`,route=>{puts.push(route.request().headers()['content-type']);return route.fulfill({json:{Key:'fixture'}});});
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('/');await page.getByRole('button',{name:'อัปโหลดไฟล์',exact:true}).click();
    const chooser=page.getByRole('dialog',{name:'เลือกหน่วยงานสำหรับอัปโหลด'});
    if(await chooser.isVisible()){
      await chooser.getByRole('combobox').selectOption(dept);
      await chooser.getByRole('button',{name:'เปิดคลังหน่วยงาน',exact:true}).click();
      await expect(chooser).not.toBeVisible();
      await page.getByRole('button',{name:'อัปโหลดไฟล์',exact:true}).click();
    }
    const queue=page.locator('.upload-queue');await expect(queue).toBeVisible();
    await expect(queue.locator('input[type=file]')).toHaveAttribute('accept',/\.pdf.*\.jpeg.*\.png/);
    // A drop can bypass the chooser's accept filter: reject it before any grant.
    await queue.evaluate(el=>{const dt=new DataTransfer();dt.items.add(new File(['%PDF-1.7'],'report.PDF',{type:''}));dt.items.add(new File(['bad'],'bad.txt',{type:'text/plain'}));el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));});
    await expect(queue.getByText('สำเร็จ', {exact:true})).toBeVisible();await expect(queue.getByText(/รับเฉพาะไฟล์ PDF/)).toBeVisible();
    expect(submitted).toHaveLength(1);expect(submitted[0].contentType).toBe('application/pdf');expect(puts).toEqual(['application/pdf']);
    completion='invalid';await queue.locator('input[type=file]').setInputFiles({name:'fake.pdf',mimeType:'application/pdf',buffer:Buffer.from('not pdf')});
    await expect(queue.getByText(/ไฟล์ไม่ผ่านการตรวจประเภท/)).toBeVisible();await expect(queue.getByText('ไม่สำเร็จ',{exact:true})).toBeVisible();
    completion='unavailable';await queue.locator('input[type=file]').setInputFiles({name:'retry.pdf',mimeType:'application/pdf',buffer:fixturePdf()});
    await expect(queue.getByText(/ตรวจประเภทไฟล์ไม่ได้ชั่วคราว/)).toBeVisible();
    await expect(queue.getByRole('listitem').filter({hasText:'retry.pdf'}).getByText(/ยังยืนยันผลไม่ได้/)).toBeVisible();
    completion='scan';
    await queue.locator('input[type=file]').setInputFiles(
      ['scan.pdf','threat.pdf','blocked.pdf'].map(name=>({name,mimeType:'application/pdf',buffer:fixturePdf()})),
    );
    const scanRow=queue.getByRole('listitem').filter({hasText:'scan.pdf'});
    await expect(scanRow.getByText('รอสแกน',{exact:true})).toBeVisible();
    await expect(scanRow.getByRole('button',{name:'เปิดเอกสาร'})).toHaveCount(0);
    await expect(scanRow.getByText('กำลังสแกน',{exact:true})).toBeVisible();
    await expect(scanRow.getByText('พร้อมใช้',{exact:true})).toBeVisible({timeout:12_000});
    await expect(scanRow.getByRole('button',{name:'เปิดเอกสาร'})).toBeVisible();
    await expect(queue.getByRole('listitem').filter({hasText:'threat.pdf'}).getByText(/พบภัย/)).toBeVisible();
    await expect(queue.getByRole('listitem').filter({hasText:'blocked.pdf'}).getByText(/ตรวจไม่ได้/)).toBeVisible();
    expect(errors).toEqual([]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(process.env.SECURITY_SCREENSHOT_DIR){mkdirSync(process.env.SECURITY_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.SECURITY_SCREENSHOT_DIR,`file-validation-${width}.png`)});}
    await context.close();
  }
});
