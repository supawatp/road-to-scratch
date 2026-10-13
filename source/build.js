const fs=require('fs');
const P=JSON.parse(fs.readFileSync(__dirname+'/program.json','utf8'));
let t=fs.readFileSync(__dirname+'/template.html','utf8');
if(!t.includes('/*PROGRAM*/null')) throw new Error('placeholder missing');
t=t.replace('/*PROGRAM*/null', JSON.stringify(P));
fs.writeFileSync(__dirname+'/road-to-scratch.html', t);
// syntax check of inline script
const js=t.split('<script>')[1].split('</script>')[0];
new Function(js);
console.log('built', t.length, 'bytes; script parses OK');
