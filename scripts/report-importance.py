"""Compare retained baselines with attention-guided fits, including failures.

Usage: python scripts/report-importance.py [candidate] [baseline] [report-name]
Folders are relative to reference/automatic-importance; defaults reproduce the pilot.
"""
import json
from pathlib import Path
from statistics import median
import sys

root=Path(__file__).resolve().parents[1]/'reference/automatic-importance'
candidate_name,baseline_name,report_name=(sys.argv[1:]+['guided','baseline','comparison'][len(sys.argv)-1:])[:3]
rows=[]
for candidate in sorted((root/candidate_name).glob('*/results.json')):
    baseline=root/baseline_name/candidate.parent.name/'results.json'
    if not baseline.exists():
        continue
    before=json.loads(baseline.read_text())['rows'][0]
    after=json.loads(candidate.read_text())['rows'][0]
    change=100*(after['rmse']/before['rmse']-1)
    rows.append(dict(case=candidate.parent.name,rmseChangePercent=change,
                     opaqueChangePercent=100*(after['opaqueRmse']/before['opaqueRmse']-1),
                     spillChange=after['spill']-before['spill'],
                     globalGate=change<=2,spillGate=after['spill']-before['spill']<=.0001))
report=dict(candidate=candidate_name,baseline=baseline_name,cases=rows,
            medianRmseChangePercent=median(r['rmseChangePercent'] for r in rows) if rows else None,
            improved=sum(r['rmseChangePercent']<0 for r in rows),regressed=sum(r['rmseChangePercent']>0 for r in rows),
            failedGates=[r['case'] for r in rows if not (r['globalGate'] and r['spillGate'])],
            promotion='NOT APPROVED: meaningful-region, held-out category, multi-seed and 512px validation still required',
            timing='Concurrent regression runs can contend for CPU; these fit timings are not valid isolated speed comparisons.')
(root/f'{report_name}.json').write_text(json.dumps(report,indent=2))
print(json.dumps({k:v for k,v in report.items() if k!='cases'},indent=2))
for r in rows:
    print(f"{r['case']:24s} rmse {r['rmseChangePercent']:+.3f}%  opaque {r['opaqueChangePercent']:+.3f}%  spill {r['spillChange']:+.7f}")
