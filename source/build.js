const fs=require('fs');
// buildHtml(): template.html + program.json (+ optional extra <script> injected before the app script).
// Running `node source/build.js` still writes source/road-to-scratch.html exactly as before.
function buildHtml({ program, shim } = {}) {
  const P=program||JSON.parse(fs.readFileSync(__dirname+'/program.json','utf8'));
  let t=fs.readFileSync(__dirname+'/template.html','utf8');
  if(!t.includes('/*PROGRAM*/null')) throw new Error('placeholder missing');
  t=t.replace('/*PROGRAM*/null', () => JSON.stringify(P));
  if(shim){
    if(!t.includes('<script>')) throw new Error('<script> tag missing');
    t=t.replace('<script>', () => '<script>\n'+shim+'\n</script>\n<script>');
  }
  // syntax check of every inline script
  t.split('<script>').slice(1).forEach(s => new Function(s.split('</script>')[0]));
  return t;
}
module.exports = { buildHtml };
if (require.main === module) {
  const t=buildHtml();
  fs.writeFileSync(__dirname+'/road-to-scratch.html', t);
  console.log('built', t.length, 'bytes; script parses OK');
}
