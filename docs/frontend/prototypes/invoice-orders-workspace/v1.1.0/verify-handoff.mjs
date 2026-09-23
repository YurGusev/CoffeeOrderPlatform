import { readFile, access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root=dirname(fileURLToPath(import.meta.url));
const repo=resolve(root,'../../../../..');
const evidence=join(root,'evidence');
const contract=JSON.parse(await readFile(join(root,'ui-contract.json'),'utf8'));
const html=await readFile(join(root,'index.html'),'utf8');
const prototype=await readFile(join(root,'prototype.js'),'utf8');
const renderedSource=`${html}\n${prototype}`;
const design=await readFile(join(root,'DESIGN.md'),'utf8');
const handoff=await readFile(join(root,'AGENT_HANDOFF.md'),'utf8');
const componentMap=await readFile(join(root,'COMPONENT_MAP.md'),'utf8');
const acceptance=await readFile(join(root,'ACCEPTANCE.md'),'utf8');
const prompt=await readFile(join(root,'IMPLEMENTATION_PROMPT.md'),'utf8');
const generated=await readFile(join(repo,'packages/generated/client-v1/dist/types.gen.d.ts'),'utf8');
const frontmatterMatch=design.match(/^---\n([\s\S]*?)\n---/);
const designMeta=frontmatterMatch?yaml.load(frontmatterMatch[1]):null;

let checks=0;
const defects=[];
const assert=(condition,label)=>{checks+=1;if(!condition)defects.push(label)};
const requiredLocal=[...Object.values(contract.referenceFiles),'README.md','source-manifest.json'];
for(const path of requiredLocal){
  try{await access(join(root,path));assert(true,`file exists: ${path}`)}catch{assert(false,`missing file: ${path}`)}
}
for(const path of contract.canonicalProjectSources){
  try{await access(join(repo,path));assert(true,`canonical source exists: ${path}`)}catch{assert(false,`missing canonical source: ${path}`)}
}
for(const selector of contract.stableSelectors){
  const double=`data-ui="${selector}"`;
  const single=`data-ui='${selector}'`;
  assert(renderedSource.includes(double)||renderedSource.includes(single),`missing data-ui hook: ${selector}`);
}
for(const [name,content] of Object.entries({design,handoff,componentMap,acceptance,prompt,html,prototype})){
  assert(!content.includes('[truncated]'),`${name}: contains truncated placeholder`);
  assert(content.trim().length>500,`${name}: unexpectedly short`);
}
assert(html.includes('data-design-id="orders-workspace-v1"'),'design id is bound to render');
assert(contract.designId==='orders-workspace-v1','contract design id');
assert(designMeta?.id===contract.designId,'DESIGN.md frontmatter design id');
assert(designMeta?.status==='approved-reference','DESIGN.md frontmatter status');
assert(contract.visualSource.commit==='3d4b30b1eaac14c77f41d8779f5e03c54cfacbef','visual source commit');
assert(generated.includes('export type OrderCardResponse'),'generated OrderCardResponse exists');
assert(generated.includes("allowedActions: Array<'edit-items' | 'confirm' | 'request-aroma-reconciliation'>"),'allowedActions union matches handoff');
assert(contract.contractGaps.some(x=>x.id==='invoice-orders-registry-api'),'invoice/orders registry contract gap is explicit');
assert(contract.contractGaps.some(x=>x.id==='invoice-projection'),'invoice contract gap is explicit');
assert(contract.contractGaps.some(x=>x.id==='payment-projection'),'payment contract gap is explicit');
assert(design.includes('## 11. Contract gaps'),'design names contract gaps');
assert(handoff.includes('## Action gating'),'handoff names action gating');
assert(acceptance.includes('**VIS-01**')&&acceptance.includes('**INV-01**')&&acceptance.includes('**SEC-07**'),'acceptance range present');
assert(prototype.includes('invoiceGroupRow')&&prototype.includes('data-invoice-toggle'),'invoice hierarchy behavior exists');
assert(prototype.includes('data-invoice-ref'),'orders bind to invoice groups in the fixture');
assert(prototype.includes('fitInlinePanel')&&prototype.includes('updateRegistryScrollHint'),'adaptive viewport behavior exists');
assert(contract.stableSelectors.includes('registry-scroll-hint')&&contract.stableSelectors.includes('items-scroll-hint'),'scroll affordance selectors declared');
assert(contract.verification.servedViewports.length===11,'served monitor and diagnostic viewport matrix declared');
assert(contract.verification.liveResizeViewports.length===6,'live resize matrix declared');
assert(design.includes('1024x600')&&design.includes('3840x2160'),'desktop monitor range documented');
assert(acceptance.includes('**VIS-15**'),'adaptive resize acceptance present');

const report={designId:contract.designId,checks,defects,stableSelectors:contract.stableSelectors.length,referenceFiles:requiredLocal.length,canonicalSources:contract.canonicalProjectSources.length};
await mkdir(evidence,{recursive:true});
await writeFile(join(evidence,'handoff-verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
if(defects.length)process.exitCode=1;
