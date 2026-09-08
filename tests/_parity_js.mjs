import fs from 'fs';

const fixtures = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const libPath = process.argv[4];
const { buildResult } = await import(libPath);

const out = fixtures.map((f) => {
  const r = buildResult(f.pkg, f.llm, 'gemini-3.1-flash-lite', 1.0, '1/1');
  const typeRow = (r.specifics || []).find(([k]) => k === 'Type');
  return {
    name: f.name,
    title: r.titles && r.titles[0] ? r.titles[0].text : '',
    category: r.category,
    fitment: r.fitment,
    type: typeRow ? typeRow[1] : '',
    halluc: (r.verify && r.verify.hallucinated) || [],
    ok: r.ok,
    html: r.html,
  };
});
fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 2));
