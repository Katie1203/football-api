#!/usr/bin/env python3
"""Train four-scenario AI Goal calibration from settled LIVE snapshots.
Usage: python train_ai_goal_v4_scenarios.py snapshots.csv
Required CSV: fixture_id, observed_at (ISO timestamp), goal_after (0/1),
 homeTotalShots,awayTotalShots,homeShotsOnTarget,awayShotsOnTarget.
Optional: paired Corners, BigChances, ExpectedGoals, ShotsInsideBox, Possession,
 window5ShotsOnTarget, window5TotalShots, window10ShotsOnTarget, window10TotalShots.
Use statistics AT observation, not full-time statistics. One observation per fixture.
No model is written unless held-out tests pass.
"""
import csv,json,subprocess,sys,math
from pathlib import Path
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss,roc_auc_score
ROOT=Path(__file__).resolve().parent
REPORT=ROOT/'ai_goal_v4_scenario_training_report.json'
MODEL=ROOT/'ai_goal_v4_scenario_model.json'

def main():
    if len(sys.argv)!=2:sys.exit(__doc__)
    with open(sys.argv[1],encoding='utf-8-sig',newline='') as f: rows=list(csv.DictReader(f))
    valid=[];seen=set()
    for r in sorted(rows,key=lambda r:r.get('observed_at','')):
        fid=str(r.get('fixture_id','')).strip()
        if not fid or fid in seen or r.get('goal_after') not in ('0','1') or not r.get('observed_at'):continue
        seen.add(fid);valid.append(r)
    # JS extraction guarantees exact agreement with production features and original AI Goal.
    script=r'''
const fs=require('fs');const rows=JSON.parse(fs.readFileSync(0,'utf8'));
const v4=require('./rule_v4_probability'),ai=require('./ai_goal_v4'),sc=require('./v4_goal_scenarios');
for(const r of rows){
 const s={_present:{}};
 for(const field of ['TotalShots','ShotsOnTarget','Corners','BigChances','ExpectedGoals','ShotsInsideBox','Possession']){
  for(const side of ['home','away']){const k=side+field,v=r[k];if(v!==undefined&&v!==null&&v!==''&&Number.isFinite(Number(v))&&Number(v)>=0){s[k]=Number(v);s._present[k]=true;}}
 }
 const w={};for(const [key,prefix] of [['five','window5'],['ten','window10']]){
  const delta={};for(const k of ['ShotsOnTarget','TotalShots']){const v=r[prefix+k];if(v!==undefined&&v!==null&&v!==''&&Number.isFinite(Number(v))&&Number(v)>=0)delta[k]=Number(v);}
  w[key]={available:Object.keys(delta).length>0,delta};
 }
 const rp=v4.predict(s),ap=rp===null?null:ai.predict(s,rp,w);
 const sf=sc.extract(s,w);const p=ap?.percent;
 process.stdout.write(JSON.stringify({fixture_id:r.fixture_id,observed_at:r.observed_at,y:Number(r.goal_after),x:sf&&p!=null?[Math.log(Math.max(.001,Math.min(.999,p/100))/(1-Math.max(.001,Math.min(.999,p/100)))),...sf]:null,base:p==null?null:p/100})+'\n');
}
'''
    p=subprocess.run(['node','-e',script],input=json.dumps(valid),text=True,capture_output=True,cwd=ROOT,check=True)
    items=[json.loads(line) for line in p.stdout.splitlines() if line.strip()]
    items=[x for x in items if x['x'] is not None and math.isfinite(x['base'])]
    report={'status':'NOT_TRAINED','unique_fixtures':len(items),'source':'chronological settled LIVE observations','note':'No active model replaced.'}
    if len(items)<300 or sum(x['y'] for x in items)<70 or sum(1-x['y'] for x in items)<70:
        report['reason']='Require >=300 distinct matches with >=70 wins and >=70 losses and usable statistics.'
    else:
        cut=int(len(items)*.75);tr,te=items[:cut],items[cut:]
        x=np.array([r['x'] for r in tr],dtype=float);y=np.array([r['y'] for r in tr]);xt=np.array([r['x'] for r in te]);yt=np.array([r['y'] for r in te]);
        mean=x.mean(axis=0);std=np.maximum(x.std(axis=0),1e-6)
        clf=LogisticRegression(C=.03,max_iter=3000,random_state=42).fit((x-mean)/std,y)
        prob=clf.predict_proba((xt-mean)/std)[:,1];base=np.array([r['base'] for r in te]);sel=prob>.65
        wins=int(yt[sel].sum());count=int(sel.sum());rate=wins/count if count else None
        old_brier=float(brier_score_loss(yt,base));new_brier=float(brier_score_loss(yt,prob))
        accepted=count>=30 and rate>=.65 and new_brier<old_brier
        report.update(status='ACCEPTED_OFFLINE' if accepted else 'REJECTED',train=len(tr),holdout=len(te),
          base_brier=old_brier,enhanced_brier=new_brier,alerts_over65=count,alerts_won=wins,win_rate=rate,
          base_auc=float(roc_auc_score(yt,base)) if len(set(yt))==2 else None,
          enhanced_auc=float(roc_auc_score(yt,prob)) if len(set(yt))==2 else None)
        if accepted:
            features=json.loads(subprocess.run(['node','-e',"console.log(JSON.stringify(require('./v4_goal_scenarios').FEATURES))"],capture_output=True,text=True,cwd=ROOT,check=True).stdout)
            m={'type':'ai_goal_v4_scenario_calibration_v1','features':features,'bias':float(clf.intercept_[0]),
               'weights':clf.coef_[0].tolist(),'means':mean.tolist(),'stds':std.tolist(),
               'validation':{'accepted':True,'holdout':len(te),'alerts_over65':count,'win_rate':rate,'brier':new_brier}}
            MODEL.write_text(json.dumps(m,indent=2)+'\n',encoding='utf-8')
    REPORT.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(report,indent=2))
if __name__=='__main__':main()
