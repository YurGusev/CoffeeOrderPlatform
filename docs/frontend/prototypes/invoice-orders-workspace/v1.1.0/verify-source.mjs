import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=dirname(fileURLToPath(import.meta.url));
const sourceRoot=process.argv[2]||join(root,'sources','legacy-presentation');
const manifest=JSON.parse(await readFile(join(root,'source-manifest.json'),'utf8'));
const bundle=await readFile(join(root,'exact-source.css'),'utf8');
const sha=data=>createHash('sha256').update(data).digest('hex');
const entries=[];
const transforms=[];

for(const item of manifest.files){
  const actual=sha(await readFile(join(sourceRoot,item.path)));
  entries.push({kind:'css-source',path:item.path,expected:item.sha256,actual,match:actual===item.sha256});
  if(item.prefix){
    const marker=`.${item.prefix}_`;
    const present=bundle.includes(marker);
    transforms.push({path:item.path,prefix:item.prefix,declaredClassCount:item.classCount,marker,present});
  }
}

const embeddedFonts=[...bundle.matchAll(/url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/g)].map(match=>Buffer.from(match[1],'base64'));
for(const [index,item] of manifest.fontFiles.entries()){
  const bytes=embeddedFonts[index];
  const actual=bytes?sha(bytes):null;
  const family=item.family.toLowerCase();
  entries.push({kind:'embedded-font',path:`@fontsource-variable/${family}@5.3.0/${item.path}`,expected:item.sha256,actual,match:actual===item.sha256});
}

const mismatches=entries.filter(item=>!item.match);
const missingTransforms=transforms.filter(item=>!item.present||item.declaredClassCount<=0);
const report={
  sourceRepository:manifest.sourceRepository,
  sourceCommit:manifest.commit,
  sourceRoot,
  checked:entries.length,
  matches:entries.filter(item=>item.match).length,
  embeddedFontCount:embeddedFonts.length,
  manifestFontCount:manifest.fontFiles.length,
  transformedModules:transforms.length,
  mismatches,
  missingTransforms,
  entries,
  transforms
};
await mkdir(join(root,'evidence'),{recursive:true});
await writeFile(join(root,'evidence','source-verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({sourceCommit:report.sourceCommit,checked:report.checked,matches:report.matches,embeddedFonts:report.embeddedFontCount,transformedModules:report.transformedModules,mismatches:mismatches.length,missingTransforms:missingTransforms.length}));
if(mismatches.length||missingTransforms.length||embeddedFonts.length!==manifest.fontFiles.length)process.exitCode=1;
