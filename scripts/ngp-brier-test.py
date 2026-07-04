import csv
from collections import defaultdict
goals = defaultdict(list)
with open('/tmp/ngp_goals.csv') as f:
    for row in csv.reader(f):
        if len(row) < 2: continue
        try: goals[int(row[0])].append(int(row[1]))
        except: pass
preds = []
with open('/tmp/ngp_preds.csv') as f:
    for row in csv.reader(f):
        if len(row) < 4: continue
        try: preds.append((int(row[0]), int(row[1]), int(row[2]), int(row[3])))
        except: pass
fixg = set(goals.keys())
shadow = set(p[0] for p in preds)
n = 0; sbb = 0.0; sbt = 0.0
buckets = defaultdict(lambda: [0, 0.0, 0.0])
for fx, mn, base, td in preds:
    if fx not in fixg: continue
    real = 1 if any(g > mn for g in goals[fx]) else 0
    pb = base/100.0; pt = td/100.0
    eb = (pb-real)**2; et = (pt-real)**2
    n += 1; sbb += eb; sbt += et
    k = '00-29' if mn<30 else '30-59' if mn<60 else '60-74' if mn<75 else '75+'
    buckets[k][0]+=1; buckets[k][1]+=eb; buckets[k][2]+=et
print('Fixturi shadow cu goluri in DB:', len(fixg & shadow))
print('Sample-uri evaluate:', n)
print()
if n == 0:
    print('Zero evaluabile.')
else:
    bb = sbb/n; bt = sbt/n
    print('Brier BASE (calibrare veche): %.5f' % bb)
    print('Brier TD   (time-decay nou):  %.5f' % bt)
    d = bb - bt
    print('Delta (base - td): %+.5f' % d)
    if d > 0.0005: print('>>> TD MAI BUN cu %.5f' % d)
    elif d < -0.0005: print('>>> TD MAI PROST cu %.5f' % (-d))
    else: print('>>> Practic egale')
    print()
    print('Defalcare pe faza (decay musca la 75+):')
    print('%-8s %-7s %-11s %-11s %s' % ('Faza','N','Brier_base','Brier_td','Delta'))
    for k in ['00-29','30-59','60-74','75+']:
        c, xb, xt = buckets[k]
        if c == 0: continue
        print('%-8s %-7d %-11.5f %-11.5f %+.5f' % (k, c, xb/c, xt/c, (xb-xt)/c))
