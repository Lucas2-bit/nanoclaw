import sqlite3, json, shutil, os, subprocess, datetime
SRC='store/ulterior.db'; CP='/tmp/.c4_dry.db'
shutil.copy(SRC, CP)
c=sqlite3.connect(CP); c.row_factory=sqlite3.Row
def n(q): return c.execute(q).fetchone()[0]
b_total=n("SELECT COUNT(*) FROM intuition_log")
print("BEFORE total=",b_total,
      "active=",n("SELECT COUNT(*) FROM intuition_log WHERE curation_state='active'"),
      "merged=",n("SELECT COUNT(*) FROM intuition_log WHERE curation_state='merged'"),
      "archived=",n("SELECT COUNT(*) FROM intuition_log WHERE curation_state='archived'"),
      "archive_tbl=",n("SELECT COUNT(*) FROM memory_archive"),
      "dupgroups=",n("SELECT COUNT(*) FROM (SELECT observation FROM intuition_log WHERE curation_state='active' GROUP BY observation HAVING COUNT(*)>1)"))
now=datetime.datetime.utcnow()
DEDUP="UPDATE intuition_log SET curation_state='merged', merged_into=(SELECT w.id FROM intuition_log w WHERE w.observation=intuition_log.observation AND w.curation_state='active' ORDER BY w.reinforcement_score DESC,w.updated_at DESC,w.id ASC LIMIT 1), updated_at=? WHERE curation_state='active' AND id<>(SELECT w.id FROM intuition_log w WHERE w.observation=intuition_log.observation AND w.curation_state='active' ORDER BY w.reinforcement_score DESC,w.updated_at DESC,w.id ASC LIMIT 1) AND observation IN (SELECT observation FROM intuition_log WHERE curation_state='active' GROUP BY observation HAVING COUNT(*)>1)"
cur=c.execute(DEDUP,(now.isoformat(),)); dd=cur.rowcount
rows=c.execute("SELECT * FROM intuition_log WHERE curation_state='active' LIMIT 3").fetchall()
arch_ok=0; arch_err=None
for row in rows:
    try:
        c.execute("INSERT OR IGNORE INTO memory_archive (source_table,source_id,data,archived_at,archive_reason,restorable) VALUES (?,?,?,?,?,?)",('intuition_log',row['id'],json.dumps(dict(row)),now.isoformat(),'consolidation_decay',1)); arch_ok+=1
    except Exception as e: arch_err=repr(e)
a_total=n("SELECT COUNT(*) FROM intuition_log")
print("RESULT dedup_merged=",dd," archive_inserted=",arch_ok," archive_err=",arch_err)
print("AFTER total=",a_total,
      "active=",n("SELECT COUNT(*) FROM intuition_log WHERE curation_state='active'"),
      "merged=",n("SELECT COUNT(*) FROM intuition_log WHERE curation_state='merged'"),
      "archive_tbl=",n("SELECT COUNT(*) FROM memory_archive"))
print("ZERO_DELETIONS=", (b_total==a_total))
print("ARCHIVE_SAMPLE=", dict(c.execute("SELECT source_table,source_id,archive_reason,restorable FROM memory_archive LIMIT 1").fetchone() or {}))
print("LOADER:")
print(subprocess.run("grep -n 'current_tasks.json\\|readFile\\|JSON.parse\\|watch(' src/container-runner.ts | head -25",shell=True,capture_output=True,text=True).stdout)
c.close(); os.remove(CP)
