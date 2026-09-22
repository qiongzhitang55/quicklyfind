import json, io, os
g = json.load(open(r"D:\quicklyFind\card\grids\法术书.json", encoding="utf-8"))
cells = g["cells"]
def col(n):
    s=""
    while n:
        n,r=divmod(n-1,26); s=chr(65+r)+s
    return s
print("行 | " + " | ".join(f"{col(c)}({c})" for c in range(21,27)))
print("-"*90)
for r in range(1, 16):
    vals=[]
    for c in range(21,27):
        v = cells.get(f"{r},{c}", "")
        vals.append(f"{v[:16]}")
    print(f"R{r:<2}| " + " | ".join(vals))
