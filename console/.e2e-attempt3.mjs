import {chromium} from '@playwright/test';
const encoded=encodeURIComponent('SimulatorLife/RacingGame');const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1100}});
await page.goto('http://127.0.0.1:3401/playtesting?workspaceId='+encoded,{waitUntil:'networkidle',timeout:90000});
await page.getByRole('button',{name:'Start playtest'}).click();
await page.waitForFunction(()=>new URL(location.href).searchParams.has('liveBatch'),null,{timeout:15000});
const batch=new URL(page.url()).searchParams.get('liveBatch');console.log('STARTED',batch);
const end=Date.now()+120000;while(Date.now()<end){await page.waitForTimeout(2500);const t=await page.locator('body').innerText();const a=t.indexOf('RUN STATUS'),z=t.indexOf('LATEST RESULT');const s=t.slice(a,z<0?undefined:z);if(s.includes(batch)&&/Completed|Failed|Cancelled|Truncated/.test(s)){console.log('RUN',s.replace(/\n/g,' | ').slice(0,300));break;}}
const ep=batch+'.a-0001';
await page.goto('http://127.0.0.1:3401/playtesting?view=sessions&workspaceId='+encoded+'&sessions='+ep,{waitUntil:'networkidle',timeout:60000});
await page.getByRole('button',{name:'Start analyst review'}).click();
let prev='';const aend=Date.now()+660000;
while(Date.now()<aend){await page.waitForTimeout(5000);const b=await page.locator('body').innerText();const i=b.indexOf('ANALYZE SELECTED SESSIONS');const tail=b.slice(i,i+1500);if(tail!==prev){console.log(new Date().toISOString(),tail.replace(/\n/g,' | '));prev=tail;}const after=tail.split('Start analyst review')[1]??'';if(/persisted review|ended without|could not be started|reviewed/i.test(after))break;}
await page.screenshot({path:'/tmp/playtesting-analysis-attempt3.png',fullPage:true});console.log('DONE',batch);await browser.close();

