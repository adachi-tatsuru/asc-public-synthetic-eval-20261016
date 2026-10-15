from pathlib import Path
values={"a":"upstream","b":"downstream","c":"independent"}
for key,value in values.items():
 p=Path(key+".txt")
 if p.exists():
  assert p.read_text().strip()==value
  if key=="b": assert Path("a.txt").read_text().strip()=="upstream"
print("SYNTHETIC_ISSUE_ORACLE_COMPLETED")
