'use strict';
// Explainable LIVE scenario classification for audit/display only.
// Does not modify Rule V4, AI Goal probabilities, alert gates or BIG BET.
const num=v=>v===null||v===undefined||v===''?null:(Number.isFinite(Number(v))?Number(v):null);
function pair(s,key){const h='home'+key,a='away'+key;if(s?._present?.[h]!==true||s?._present?.[a]!==true)return null;const x=num(s[h]),y=num(s[a]);return x!==null&&y!==null&&x>=0&&y>=0?[x,y]:null;}
function delta(w,key){if(w?.available!==true)return null;return num(w?.delta?.[key]);}
const make=(active,detail,rule)=>({active, status:active===null?'KHÔNG ĐỦ DỮ LIỆU':active?'ĐẠT':'KHÔNG ĐẠT',label:active===null?'Thiếu dữ liệu để đánh giá':active?'Đạt điều kiện':'Không đạt điều kiện',detail,rule});
function analyze(stats,windows){
 const sh=pair(stats,'TotalShots'),sot=pair(stats,'ShotsOnTarget'),corners=pair(stats,'Corners'),bc=pair(stats,'BigChances'),xg=pair(stats,'ExpectedGoals'),box=pair(stats,'ShotsInsideBox');
 const out={};
 // Clear, inspectable signal definitions. These are display categories, NOT score adjustments.
 const dominant=sh&&sot&&sh[0]+sh[1]>0&&sot[0]+sot[1]>0 ? [0,1].some(i=>sh[i]>=sh[1-i]*2&&sot[i]>=sot[1-i]*2&&sot[i]>=2):null;
 out.ONE_SIDE_PRESSURE=make(dominant,sh&&sot?`Shots ${sh.join('-')}; SOT ${sot.join('-')}`:'Thiếu Shots hoặc SOT','Một đội có Shots và SOT ít nhất gấp đôi đối thủ, đồng thời có ít nhất 2 SOT');
 const twoWay=sot?sot[0]>=1&&sot[1]>=1:null;
 out.TWO_WAY_ATTACK=make(twoWay,sot?`SOT ${sot.join('-')}`:'Thiếu SOT','Cả hai đội đều có ít nhất 1 SOT');
 const dSot=delta(windows?.five,'ShotsOnTarget')??delta(windows?.ten,'ShotsOnTarget');
 const dShots=delta(windows?.five,'TotalShots')??delta(windows?.ten,'TotalShots');
 const spike=dSot===null&&dShots===null?null:(dSot!==null&&dSot>=2)||(dShots!==null&&dShots>=4);
 out.H2_ATTACK_SPIKE=make(spike,`SOT tăng ${dSot===null?'N/A':dSot}; Shots tăng ${dShots===null?'N/A':dShots} trong cửa sổ 5–10 phút`,'Tăng ít nhất 2 SOT hoặc 4 cú sút trong cửa sổ 5–10 phút được xác minh');
 const quality=bc||xg||box?(bc&&bc[0]+bc[1]>=1)||(xg&&xg[0]+xg[1]>=1)||(box&&box[0]+box[1]>=4):null;
 out.HIGH_QUALITY_CHANCES=make(quality,`Big chances ${bc?bc.join('-'):'N/A'}; xG ${xg?xg.join('-'):'N/A'}; Box shots ${box?box.join('-'):'N/A'}`,'Có ít nhất 1 big chance, hoặc xG tổng ≥1, hoặc 4 cú sút trong vòng cấm');
 return out;
}
module.exports={analyze};
