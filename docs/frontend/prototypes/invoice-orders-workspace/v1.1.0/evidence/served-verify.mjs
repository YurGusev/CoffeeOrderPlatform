import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const evidence=join(root,'evidence','served');
await mkdir(evidence,{recursive:true});
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8'};
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1');
    const requested=url.pathname==='/'?'index.html':url.pathname.replace(/^\//,'');
    const file=normalize(join(root,requested));
    if(!file.startsWith(root)){res.writeHead(403).end();return}
    const body=await readFile(file);
    res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream'}).end(body);
  }catch{res.writeHead(404).end('not found')}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8783,'127.0.0.1',resolve)});
const browser=await chromium.launch({headless:true});
const results=[];
let resizeEvidence=[];
let failed=false;
async function inspect(viewport,label,{mobile=false}={}){
  const context=await browser.newContext({viewport});
  const page=await context.newPage();
  const consoleErrors=[];const pageErrors=[];const failures=[];const badResponses=[];const external=[];
  page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text())});
  page.on('pageerror',e=>pageErrors.push(e.message));
  page.on('requestfailed',r=>failures.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));
  page.on('response',r=>{if(r.status()>=400)badResponses.push(`${r.status()} ${r.url()}`)});
  page.on('request',r=>{const u=new URL(r.url());if(!['127.0.0.1'].includes(u.hostname))external.push(r.url())});
  const response=await page.goto('http://127.0.0.1:8783/',{waitUntil:'networkidle'});
  await page.screenshot({path:join(evidence,`${label}--register.png`),fullPage:true});
  const initial=await page.evaluate(()=>{
    const box=s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height),right:Math.round(r.right),bottom:Math.round(r.bottom)}};
    const visible=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0};
    const clipped=[...document.querySelectorAll('h1,.orders-workspace_pageDescription,.orders-workspace_toolbarButton,.orders-workspace_savedViewButton,.orders-table_inlineAction')].filter(visible).filter(e=>e.scrollWidth>e.clientWidth+1||e.scrollHeight>e.clientHeight+1).map(e=>e.textContent.trim());
    const bodyStyle=getComputedStyle(document.body),headingStyle=getComputedStyle(document.querySelector('h1')),toolbarStyle=getComputedStyle(document.querySelector('.orders-workspace_toolbar')),primary=document.querySelector('#new-order'),primaryStyle=getComputedStyle(primary),scroller=document.querySelector('.orders-table_tableScroller'),scrollerStyle=getComputedStyle(scroller),registryHint=document.querySelector('[data-ui="registry-scroll-hint"]'),verticalButton=registryHint.querySelector('[data-registry-scroll-more]'),horizontalButton=registryHint.querySelector('[data-registry-scroll-side]');
    return{viewport:{width:innerWidth,height:innerHeight},scrollPosition:{x:scrollX,y:scrollY},document:{clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,clientHeight:document.documentElement.clientHeight,scrollHeight:document.documentElement.scrollHeight},shell:box('.operator-shell_operatorShell'),sidebar:box('.operator-shell_sidebar'),content:box('.operator-shell_content'),heading:box('h1'),toolbar:box('.orders-workspace_toolbar'),tablePanel:box('.orders-workspace_tablePanel'),invoiceGroups:document.querySelectorAll('[data-ui="invoice-group-row"]').length,rows:document.querySelectorAll('tr[data-order]').length,clippedKeyText:clipped,typography:{bodyFamily:bodyStyle.fontFamily,bodySize:bodyStyle.fontSize,bodyLineHeight:bodyStyle.lineHeight,headingFamily:headingStyle.fontFamily,headingSize:headingStyle.fontSize},fonts:{status:document.fonts.status,inter:document.fonts.check('14px "Inter Variable"'),manrope:document.fonts.check('28px "Manrope Variable"')},surface:{toolbarRadius:toolbarStyle.borderRadius,primaryRadius:primaryStyle.borderRadius,primaryTarget:box('#new-order')},registryHint:{visible:!registryHint.hidden,text:registryHint.textContent.trim(),verticalVisible:!verticalButton.hidden,horizontalVisible:!horizontalButton.hidden,verticalState:verticalButton.dataset.scrollState,horizontalState:horizontalButton.dataset.scrollState,box:box('[data-ui="registry-scroll-hint"]')},tableScroll:{clientWidth:scroller.clientWidth,scrollWidth:scroller.scrollWidth,clientHeight:scroller.clientHeight,scrollHeight:scroller.scrollHeight,overflowX:scrollerStyle.overflowX,overflowY:scrollerStyle.overflowY}};
  });
  const registryScroll={vertical:{available:false},horizontal:{available:false}};
  if(initial.registryHint.verticalVisible){
    await page.locator('[data-registry-scroll-more]').click();
    const atEnd=await page.evaluate(()=>{const scroller=document.querySelector('.orders-table_tableScroller'),button=document.querySelector('[data-registry-scroll-more]');return{scrollTop:Math.round(scroller.scrollTop),maxScroll:Math.round(scroller.scrollHeight-scroller.clientHeight),state:button.dataset.scrollState}});
    await page.locator('[data-registry-scroll-more]').click();
    const returnedTop=await page.evaluate(()=>Math.round(document.querySelector('.orders-table_tableScroller').scrollTop));
    registryScroll.vertical={available:true,atEnd,returnedTop};
  }
  if(initial.registryHint.horizontalVisible){
    await page.locator('[data-registry-scroll-side]').click();
    const atEnd=await page.evaluate(()=>{const scroller=document.querySelector('.orders-table_tableScroller'),button=document.querySelector('[data-registry-scroll-side]');return{scrollLeft:Math.round(scroller.scrollLeft),maxScroll:Math.round(scroller.scrollWidth-scroller.clientWidth),state:button.dataset.scrollState}});
    await page.locator('[data-registry-scroll-side]').click();
    const returnedLeft=await page.evaluate(()=>Math.round(document.querySelector('.orders-table_tableScroller').scrollLeft));
    registryScroll.horizontal={available:true,atEnd,returnedLeft};
  }
  await page.locator('[data-toggle]').first().click();
  await page.locator('.orders-table_inlinePanel').waitFor({state:'visible'});
  const expanded=await page.evaluate(()=>{
    const box=s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height),right:Math.round(r.right),bottom:Math.round(r.bottom)}};
    const panel=document.querySelector('.orders-table_inlinePanel'),footer=document.querySelector('.x-inline-footer'),pagination=document.querySelector('.orders-workspace_paginationBar'),confirm=document.querySelector('[data-confirm]'),itemsScroller=document.querySelector('[data-ui="order-items-scroll"]'),itemsHint=document.querySelector('[data-ui="items-scroll-hint"]'),registryScroller=document.querySelector('.orders-table_tableScroller');
    const pr=panel.getBoundingClientRect(),fr=footer.getBoundingClientRect(),gr=pagination.getBoundingClientRect(),cr=confirm.getBoundingClientRect(),ir=itemsScroller.getBoundingClientRect(),rr=registryScroller.getBoundingClientRect();
    const verticalOverlap=Math.max(0,Math.min(fr.bottom,gr.bottom)-Math.max(fr.top,gr.top));
    const horizontalOverlap=Math.max(0,Math.min(fr.right,gr.right)-Math.max(fr.left,gr.left));
    const itemFooterVerticalOverlap=Math.max(0,Math.min(ir.bottom,fr.bottom)-Math.max(ir.top,fr.top));
    const itemFooterHorizontalOverlap=Math.max(0,Math.min(ir.right,fr.right)-Math.max(ir.left,fr.left));
    const itemRows=[...document.querySelectorAll('tr[data-item]')].map(row=>{const r=row.getBoundingClientRect(),intersection=Math.max(0,Math.min(r.bottom,ir.bottom)-Math.max(r.top,ir.top));return{top:Math.round(r.top),bottom:Math.round(r.bottom),height:Math.round(r.height),intersection:Math.round(intersection),fullyVisible:intersection>=r.height-1,partiallyVisible:intersection>1&&intersection<r.height-1}});
    const hit=cr.top>=0&&cr.bottom<=innerHeight?document.elementFromPoint(cr.left+cr.width/2,cr.top+cr.height/2):null;
    return{panel:box('.orders-table_inlinePanel'),itemsViewport:box('[data-ui="order-items-scroll"]'),itemsTable:box('.orders-table_inlineItemsTable'),itemsHint:{visible:!itemsHint.hidden,text:itemsHint.textContent.trim(),box:box('[data-ui="items-scroll-hint"]')},itemRows,itemScroll:{clientHeight:itemsScroller.clientHeight,scrollHeight:itemsScroller.scrollHeight,scrollTop:itemsScroller.scrollTop},footer:box('.x-inline-footer'),pagination:box('.orders-workspace_paginationBar'),confirm:box('[data-confirm]'),workflow:box('[data-workflow]'),footerContained:fr.left>=pr.left-4&&fr.right<=pr.right+1&&fr.bottom<=pr.bottom+1,panelInsideRegistry:pr.bottom<=rr.bottom+1,footerPaginationOverlap:verticalOverlap*horizontalOverlap,itemFooterOverlap:itemFooterVerticalOverlap*itemFooterHorizontalOverlap,partialItemRows:itemRows.filter(row=>row.partiallyVisible).length,fullyVisibleItemRows:itemRows.filter(row=>row.fullyVisible).length,confirmHit:hit===confirm||confirm.contains(hit),confirmInViewport:cr.top>=0&&cr.bottom<=innerHeight,ariaExpanded:document.querySelector('tr[data-order]')?.getAttribute('aria-expanded')};
  });
  await page.screenshot({path:join(evidence,`${label}--expanded.png`),fullPage:true});
  if(!mobile){
    if(expanded.fullyVisibleItemRows===0){
      results.push({label,mobile,httpStatus:response?.status(),initial,expanded,registryScroll,interaction:{interactionBlocked:'no-fully-visible-item-row',itemScroll:{available:false},quantityChanged:false,drawer:{visible:false,rightGap:null,initialFocus:null},escapeReturnFocus:false,outsideClose:false,outsideReturnFocus:false,workflowText:'',workflowContainsInvoice:false,workflowContainsPayment:false,productSearchRows:null,invoiceSearchOrders:null,invoiceSearchGroups:null,customerSearchRows:null},network:{consoleErrors,pageErrors,failures,badResponses,external}});
      await context.close();
      return;
    }
    const itemScroll=expanded.itemsHint.visible?await (async()=>{
      const button=page.locator('[data-items-scroll-more]');
      let steps=0;
      while(await button.getAttribute('data-scroll-state')==='more'&&steps<10){await button.click();steps++;}
      const atEnd=await page.evaluate(steps=>{const scroller=document.querySelector('[data-ui="order-items-scroll"]'),last=document.querySelector('tr[data-item]:last-child'),sr=scroller.getBoundingClientRect(),lr=last.getBoundingClientRect();return{steps,scrollTop:Math.round(scroller.scrollTop),maxScroll:Math.round(scroller.scrollHeight-scroller.clientHeight),state:document.querySelector('[data-items-scroll-more]').dataset.scrollState,lastRowFullyVisible:lr.top>=sr.top-1&&lr.bottom<=sr.bottom+1};},steps);
      await button.click();
      const returnedTop=await page.evaluate(()=>Math.round(document.querySelector('[data-ui="order-items-scroll"]').scrollTop));
      return{available:true,atEnd,returnedTop};
    })():{available:false};
    const before=await page.locator('tr[data-item]').first().locator('.orders-table_total').textContent();
    await page.locator('tr[data-item]').first().locator('[data-step="1"]').click();
    const after=await page.locator('tr[data-item]').first().locator('.orders-table_total').textContent();
    const editTrigger=page.locator('tr[data-item]').first().locator('[data-edit]');
    await editTrigger.click();
    await page.locator('#drawer-view').waitFor({state:'visible'});
    await page.screenshot({path:join(evidence,`${label}--edit-drawer.png`),fullPage:true});
    const drawer=await page.evaluate(()=>{const p=document.querySelector('.ui-dialog_panel'),r=p.getBoundingClientRect(),s=getComputedStyle(p);return{title:document.querySelector('#drawer-title')?.textContent,width:Math.round(r.width),height:Math.round(r.height),clientHeight:p.clientHeight,scrollHeight:p.scrollHeight,maxHeight:s.maxHeight,overflowY:s.overflowY,rightGap:Math.round(innerWidth-r.right),visible:r.width>0&&r.height>0,initialFocus:document.activeElement?.id}});
    await page.keyboard.press('Escape');
    const escapeReturnFocus=await editTrigger.evaluate(e=>document.activeElement===e);
    await page.locator('[data-workflow]').first().click();
    const workflowText=await page.locator('#drawer-body').innerText();
    await page.keyboard.press('Escape');
    const search=page.locator('#search');
    await search.fill('Кения');
    const productSearchRows=await page.locator('tr[data-order]').count();
    await search.fill('');
    await search.fill('A-62418');
    const invoiceSearchOrders=await page.locator('tr[data-order]').count();
    const invoiceSearchGroups=await page.locator('[data-ui="invoice-group-row"]').count();
    await search.fill('');
    await page.locator('#customer').fill('Мария');
    const customerSearchRows=await page.locator('tr[data-order]').count();
    await page.locator('#customer').fill('');
    const workflowNormalized=workflowText.toLowerCase();
    await page.locator('[data-toggle="4871"]').click();
    await page.locator('[data-add]').click();
    await page.locator('#catalog-search').fill('дрип');
    await page.locator('.ui-dialog_scrim').click({position:{x:4,y:4}});
    const outsideClose=!await page.locator('#drawer-view').isVisible();
    const outsideReturnFocus=await page.locator('[data-add]').evaluate(e=>document.activeElement===e);
    await page.locator('[data-confirm]').scrollIntoViewIfNeeded();
    const confirmReachable=await page.locator('[data-confirm]').evaluate(confirm=>{const r=confirm.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return r.top>=0&&r.bottom<=innerHeight&&(hit===confirm||confirm.contains(hit));});
    results.push({label,mobile,httpStatus:response?.status(),initial,expanded,registryScroll,interaction:{itemScroll,confirmReachable,quantityChanged:before!==after,drawer,escapeReturnFocus,outsideClose,outsideReturnFocus,workflowText,workflowContainsInvoice:workflowNormalized.includes('счёт'),workflowContainsPayment:workflowNormalized.includes('оплата'),productSearchRows,invoiceSearchOrders,invoiceSearchGroups,customerSearchRows},network:{consoleErrors,pageErrors,failures,badResponses,external}});
  }else{
    const mobileState=await page.evaluate(()=>{const scroller=document.querySelector('.orders-table_tableScroller');return{documentHorizontalOverflow:document.documentElement.scrollWidth-innerWidth,tableHorizontalOverflow:scroller.scrollWidth-scroller.clientWidth,bodyOverflowX:getComputedStyle(document.body).overflowX,activeElement:document.activeElement?.tagName}});
    results.push({label,mobile,httpStatus:response?.status(),initial,expanded,registryScroll,mobileState,network:{consoleErrors,pageErrors,failures,badResponses,external}});
  }
  await context.close();
}
async function inspectResize(){
  const context=await browser.newContext({viewport:{width:1920,height:1080}});
  const page=await context.newPage();
  await page.goto('http://127.0.0.1:8783/',{waitUntil:'networkidle'});
  const sizes=[{width:1280,height:720},{width:2560,height:1080},{width:2560,height:1440},{width:3440,height:1440},{width:1024,height:600},{width:3840,height:2160}];
  const observations=[];
  for(const size of sizes){
    await page.setViewportSize(size);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    observations.push(await page.evaluate(()=>{const doc=document.documentElement,panel=document.querySelector('.orders-workspace_tablePanel'),pr=panel.getBoundingClientRect(),scroller=document.querySelector('.orders-table_tableScroller'),hint=document.querySelector('[data-ui="registry-scroll-hint"]');return{viewport:{width:innerWidth,height:innerHeight},document:{clientWidth:doc.clientWidth,scrollWidth:doc.scrollWidth,clientHeight:doc.clientHeight,scrollHeight:doc.scrollHeight},tablePanel:{top:Math.round(pr.top),bottom:Math.round(pr.bottom),height:Math.round(pr.height)},registry:{clientWidth:scroller.clientWidth,scrollWidth:scroller.scrollWidth,clientHeight:scroller.clientHeight,scrollHeight:scroller.scrollHeight,hintVisible:!hint.hidden}};}));
  }
  await context.close();
  return observations;
}
try{
  await inspect({width:1024,height:600},'desktop-1024');
  await inspect({width:1280,height:720},'desktop-1280');
  await inspect({width:1366,height:768},'desktop-1366');
  await inspect({width:1440,height:900},'desktop-1440');
  await inspect({width:1920,height:1080},'desktop-1920');
  await inspect({width:2560,height:1080},'desktop-2560-wide');
  await inspect({width:2560,height:1440},'desktop-2560');
  await inspect({width:3440,height:1440},'desktop-3440');
  await inspect({width:3840,height:2160},'desktop-3840');
  resizeEvidence=await inspectResize();
  await inspect({width:375,height:812},'mobile-375',{mobile:true});
  await inspect({width:430,height:932},'mobile-430',{mobile:true});
  const defects=[];
  for(const r of results){
    if(r.httpStatus!==200)defects.push(`${r.label}: HTTP ${r.httpStatus}`);
    if(r.network.consoleErrors.length||r.network.pageErrors.length||r.network.failures.length||r.network.badResponses.length||r.network.external.length)defects.push(`${r.label}: console/network errors`);
    if(r.initial.rows!==6)defects.push(`${r.label}: expected six orders`);
    if(r.initial.invoiceGroups!==5)defects.push(`${r.label}: expected five invoice groups`);
    if(r.initial.document.scrollWidth!==r.initial.document.clientWidth)defects.push(`${r.label}: document horizontal overflow`);
    if(!r.mobile&&r.initial.viewport.width>1024&&r.initial.document.scrollHeight!==r.initial.document.clientHeight)defects.push(`${r.label}: desktop shell does not fit viewport height`);
    const registryVerticalOverflow=r.initial.tableScroll.scrollHeight>r.initial.tableScroll.clientHeight+1;
    const registryHorizontalOverflow=r.initial.tableScroll.scrollWidth>r.initial.tableScroll.clientWidth+1;
    if((registryVerticalOverflow||registryHorizontalOverflow)!==r.initial.registryHint.visible)defects.push(`${r.label}: registry scroll affordance mismatch`);
    if(registryVerticalOverflow!==r.initial.registryHint.verticalVisible)defects.push(`${r.label}: registry vertical affordance mismatch`);
    if(registryHorizontalOverflow!==r.initial.registryHint.horizontalVisible)defects.push(`${r.label}: registry horizontal affordance mismatch`);
    if(r.registryScroll.vertical.available&&(r.registryScroll.vertical.atEnd.scrollTop<=0||Math.abs(r.registryScroll.vertical.atEnd.maxScroll-r.registryScroll.vertical.atEnd.scrollTop)>1||r.registryScroll.vertical.atEnd.state!=='end'||r.registryScroll.vertical.returnedTop!==0))defects.push(`${r.label}: registry vertical affordance failed`);
    if(r.registryScroll.horizontal.available&&(r.registryScroll.horizontal.atEnd.scrollLeft<=0||Math.abs(r.registryScroll.horizontal.atEnd.maxScroll-r.registryScroll.horizontal.atEnd.scrollLeft)>1||r.registryScroll.horizontal.atEnd.state!=='end'||r.registryScroll.horizontal.returnedLeft!==0))defects.push(`${r.label}: registry horizontal affordance failed`);
    if(r.initial.clippedKeyText.length)defects.push(`${r.label}: clipped key text ${r.initial.clippedKeyText.join(', ')}`);
    if(r.initial.fonts.status!=='loaded'||!r.initial.fonts.inter||!r.initial.fonts.manrope)defects.push(`${r.label}: fonts not active`);
    if(r.initial.surface.primaryTarget.height<32)defects.push(`${r.label}: primary action target too small`);
    if(r.expanded.ariaExpanded!=='true')defects.push(`${r.label}: row not aria-expanded`);
    if(!r.expanded.footerContained)defects.push(`${r.label}: sticky summary outside inline panel`);
    if(!r.expanded.panelInsideRegistry)defects.push(`${r.label}: inline panel outside registry viewport`);
    if(r.expanded.footerPaginationOverlap!==0)defects.push(`${r.label}: footer overlaps pagination`);
    if(r.expanded.itemFooterOverlap!==0)defects.push(`${r.label}: item viewport overlaps footer`);
    if(r.expanded.partialItemRows!==0)defects.push(`${r.label}: partially visible item row`);
    const itemsOverflow=r.expanded.itemScroll.scrollHeight>r.expanded.itemScroll.clientHeight+1;
    if(itemsOverflow!==r.expanded.itemsHint.visible)defects.push(`${r.label}: item scroll affordance mismatch`);
    if(!r.mobile&&r.expanded.confirmInViewport&&!r.expanded.confirmHit)defects.push(`${r.label}: confirm button obscured`);
    if(!r.mobile){
      if(r.interaction.itemScroll.available&&(!r.interaction.itemScroll.atEnd.lastRowFullyVisible||r.interaction.itemScroll.atEnd.state!=='end'||r.interaction.itemScroll.returnedTop!==0))defects.push(`${r.label}: item scroll affordance failed`);
      if(!r.interaction.confirmReachable)defects.push(`${r.label}: confirm action is not reachable after scroll`);
      if(!r.interaction.quantityChanged)defects.push(`${r.label}: quantity did not update`);
      if(!r.interaction.drawer.visible||r.interaction.drawer.rightGap!==0)defects.push(`${r.label}: drawer geometry`);
      if(r.interaction.drawer.initialFocus!=='edit-product')defects.push(`${r.label}: drawer initial focus`);
      if(!r.interaction.escapeReturnFocus)defects.push(`${r.label}: escape did not return focus`);
      if(!r.interaction.outsideClose||!r.interaction.outsideReturnFocus)defects.push(`${r.label}: outside close/focus return failed`);
      if(!r.interaction.workflowContainsInvoice||!r.interaction.workflowContainsPayment)defects.push(`${r.label}: workflow content missing`);
      if(r.interaction.productSearchRows!==1||r.interaction.invoiceSearchOrders!==2||r.interaction.invoiceSearchGroups!==1||r.interaction.customerSearchRows!==1)defects.push(`${r.label}: search mismatch`);
    }else if(r.mobileState.tableHorizontalOverflow<=0)defects.push(`${r.label}: expected table scroller overflow`);
  }
  for(const observation of resizeEvidence){
    const label=`resize-${observation.viewport.width}x${observation.viewport.height}`;
    if(observation.document.scrollWidth!==observation.document.clientWidth)defects.push(`${label}: document horizontal overflow`);
    if(observation.viewport.width>1024&&observation.document.scrollHeight!==observation.document.clientHeight)defects.push(`${label}: desktop shell does not fit viewport height`);
    if(observation.viewport.width>1024&&observation.tablePanel.bottom>observation.viewport.height)defects.push(`${label}: table panel outside viewport`);
    const registryOverflows=observation.registry.scrollHeight>observation.registry.clientHeight+1||observation.registry.scrollWidth>observation.registry.clientWidth+1;
    if(registryOverflows!==observation.registry.hintVisible)defects.push(`${label}: registry scroll affordance mismatch`);
  }
  const report={generatedAt:new Date().toISOString(),surface:'http://127.0.0.1:8783/',desktopOnly:true,results,resizeEvidence,defects};
  await writeFile(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({viewports:results.map(r=>r.label),desktopInteractions:results.filter(r=>!r.mobile).length,mobileDiagnostics:results.filter(r=>r.mobile).length,resizeChecks:resizeEvidence.length,defects}));
  failed=defects.length>0;
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
if(failed)process.exitCode=1;
