import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const evidence = join(root, 'evidence');
const mime = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8' };
const server = createServer(async (req,res)=>{
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const file = normalize(join(root, pathname === '/' ? 'index.html' : pathname.slice(1)));
    if (!file.startsWith(root)) throw new Error('bad path');
    const body = await readFile(file);
    res.writeHead(200, {'content-type': mime[extname(file)] || 'application/octet-stream'}); res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(resolve=>server.listen(8782,'127.0.0.1',resolve));
const browser = await chromium.launch({headless:true});
const defects=[]; let checks=0; const screenshots=[];
const assert=(value,label)=>{checks++; if(!value) defects.push(label);};
try {
  for (const viewport of [{width:1366,height:768},{width:1440,height:900},{width:1920,height:1080}]) {
    const context=await browser.newContext({viewport}); const page=await context.newPage();
    const consoleErrors=[], failed=[], external=[];
    page.on('console',m=>{if(m.type()==='error') consoleErrors.push(m.text());});
    page.on('requestfailed',r=>failed.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`));
    page.on('request',r=>{const u=new URL(r.url()); if(!['127.0.0.1'].includes(u.hostname)) external.push(r.url());});
    await page.goto('http://127.0.0.1:8782/',{waitUntil:'networkidle'});
    assert(await page.locator('tr[data-order]').count()===6,`${viewport.width}: six orders visible`);
    assert(await page.locator('[data-ui="invoice-group-row"]').count()===5,`${viewport.width}: five invoice groups visible`);
    assert(await page.locator('tr[data-order][data-invoice-ref="A-62418"]').count()===2,`${viewport.width}: invoice groups two orders`);
    await page.locator('[data-invoice-toggle="A-62418"]').click();
    assert(await page.locator('tr[data-order]').count()===4,`${viewport.width}: invoice collapse hides its orders`);
    await page.locator('[data-invoice-toggle="A-62418"]').click();
    assert(await page.locator('tr[data-order]').count()===6,`${viewport.width}: invoice expand restores its orders`);
    assert(await page.locator('.operator-shell_sidebar').isVisible(),`${viewport.width}: original sidebar visible`);
    assert(await page.locator('.orders-workspace_toolbar').isVisible(),`${viewport.width}: original toolbar visible`);
    assert(await page.locator('.orders-table_table').isVisible(),`${viewport.width}: original table visible`);
    await page.locator('[data-toggle="4871"]').click();
    assert(await page.locator('.orders-table_inlinePanel').isVisible(),`${viewport.width}: inline details visible`);
    assert(await page.getByText('Эфиопия Гуджи',{exact:true}).first().isVisible(),`${viewport.width}: item visible`);
    const qty=page.locator('[data-qty][data-order-id="4871"][data-item-id="1"]'); const before=Number(await qty.inputValue());
    await page.locator('[data-step="1"][data-order-id="4871"][data-item-id="1"]').click();
    assert(Number(await page.locator('[data-qty][data-order-id="4871"][data-item-id="1"]').inputValue())===before+1,`${viewport.width}: quantity increment`);
    await page.locator('[data-edit="4871:1"]').click();
    assert(await page.locator('#drawer-view').isVisible(),`${viewport.width}: editor drawer visible`);
    await page.locator('#edit-product').selectOption('7'); await page.locator('#edit-qty').fill('2'); await page.locator('#save-edit').click();
    assert(await page.getByText('Кения Кириньяга',{exact:true}).first().isVisible(),`${viewport.width}: product replaced`);
    await page.locator('[data-add="4871"]').click(); await page.locator('#catalog-search').fill('дрип'); await page.locator('[data-catalog-add="8"]').click();
    assert(await page.locator('#toast-text').textContent()==='Дрип-пакеты Эфиопия добавлен',`${viewport.width}: catalog add`); await page.locator('[data-close]').last().click();
    await page.locator('[data-remove="4871:2"]').click(); assert(await page.locator('#undo').isVisible(),`${viewport.width}: undo visible`); await page.locator('#undo').click();
    assert(await page.getByText('Бразилия Сантос',{exact:true}).first().isVisible(),`${viewport.width}: undo restored`);
    await page.locator('[data-workflow="4871"]').last().click(); assert(await page.getByText('Корзина AROMA',{exact:true}).isVisible(),`${viewport.width}: workflow drawer visible`); await page.keyboard.press('Escape');
    assert(!(await page.locator('#drawer-view').isVisible()),`${viewport.width}: drawer closes by escape`);
    const inlineBox=await page.locator('.orders-table_inlinePanel').boundingBox(); const footerBox=await page.locator('.x-inline-footer').boundingBox();
    assert(Boolean(inlineBox&&footerBox&&footerBox.y+footerBox.height<=inlineBox.y+inlineBox.height+1),`${viewport.width}: inline footer contained`);
    assert(consoleErrors.length===0,`${viewport.width}: no console errors: ${consoleErrors.join('; ')}`);
    assert(failed.length===0,`${viewport.width}: no failed requests: ${failed.join('; ')}`);
    assert(external.length===0,`${viewport.width}: no external requests: ${external.join('; ')}`);
    const shot=join(evidence,`expanded--${viewport.width}x${viewport.height}.png`); await page.screenshot({path:shot,fullPage:false}); screenshots.push(shot);
    await context.close();
  }
  const report={checks,screenshots:screenshots.length,defects,viewports:['1366x768','1440x900','1920x1080'],sourceCommit:'3d4b30b1eaac14c77f41d8779f5e03c54cfacbef'};
  await import('node:fs/promises').then(({mkdir,writeFile})=>mkdir(evidence,{recursive:true}).then(()=>writeFile(join(evidence,'results.json'),JSON.stringify(report,null,2)+'\n')));
  console.log(JSON.stringify(report)); if(defects.length) process.exitCode=1;
} finally {await browser.close(); await new Promise(resolve=>server.close(resolve));}
