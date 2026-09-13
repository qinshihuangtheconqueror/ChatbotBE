# PowerShell API Testing — Common Errors & Rules

## ✅ CONFIRMED WORKING APPROACH (dùng -Body hashtable)

```powershell
$b  = "https://api-dot-hust-edu.appspot.com/partner/api"
$tk = "7927111D54A889F1839E28ACF3453-AI"
$h  = @{
    Authorization = "Bearer o1YwE0WKVkz/UverjBti6RI87CR+3B1GY8VyAhtfZL4DP8mlypuI/LMsGR5v+6s2"
    Cookie        = "JSESSIONID=bEU4OJAPEuyxqJBz5cC85g"
}

# Dùng -Body hashtable, KHÔNG dùng URL string với &
# PowerShell tự xử lý encoding của hashtable QS
$r = Invoke-RestMethod -Method Post -Uri ($b + "/grades") -Headers $h `
     -Body @{ token=$tk; studentId="202416773"; semester="20241" }
```

> **Root cause lỗi trước đó:** `&` trong PowerShell URL string bị parse làm background operator → params bị cắt → 400 "Required parameter is not present"

## ⚠️ KHÔNG dùng cách này (& bị parse sai)

```powershell
# ❌ SAI - & bị PS parse thành background operator
"$base/grades?token=$token&studentId=$sid"

# ❌ CŨNG SAI - cả trong .ps1 file
$url = $b + "/grades?token=" + $tk + "&studentId=" + $s
```

## 1. PowerShell Aliases — NEVER use short flags

| ❌ Wrong | ✅ Correct |
|---|---|
| `-M Post` | `-Method Post` |
| `-U $url` | `-Uri $url` |
| `-B '...'` | `-Body '...'` |

> `-M` is ambiguous between `-Method` and `-MaximumRedirection` → always use full name.

---

## 2. Unix Commands NOT Available in PowerShell

| ❌ Unix | ✅ PowerShell Equivalent |
|---|---|
| `\| head -30` | `\| Select-Object -First 30` |
| `\| tail -20` | `\| Select-Object -Last 20` |
| `grep "foo"` | `Select-String "foo"` |
| `cat file` | `Get-Content file` |
| `wc -l` | `(Get-Content file).Count` |

---

## 3. HUST Partner API — Params Are camelCase JSON Body

All endpoints: `POST url?token=$token` with **JSON body** (not query string).

| ❌ Wrong | ✅ Correct |
|---|---|
| `student_id` | `studentId` |
| `semester_id` | `semesterId` |
| `program_id` | `programId` |
| `course_id` | `courseId` |
| `teacher_id` | `teacherId` |

### Confirmed Working Request Pattern
```powershell
$h = @{
  "Authorization" = "Bearer ..."
  "Cookie" = "JSESSIONID=..."
}
$body = '{"studentId":"20225976","semesterId":"20251"}'
$r = Invoke-RestMethod -Method Post `
     -Uri "$base/grades?token=$token" `
     -ContentType "application/json" `
     -Headers $h `
     -Body $body
```

---

## 4. Semester Format

- Format: `YYYYS` — e.g., `20251` (2025 kỳ 1), `20252` (2025 kỳ 2)
- **Current semester**: `20252` (currentForClass=true, currentForProject=true as of March 2026)
- **For testing graduated student 20225976**: use `20241` or `20251` (last active semesters)
- MSSV `20225976` is **GRADUATED** — `/grades`, `/classes`, `/exams` return 0 items for 20252

---

## 5. Output Truncation — Always Write to File

Console output is truncated for large JSON. Use:
```powershell
$r | ConvertTo-Json -Depth 8 | Out-File "C:\tmp\result.json" -Encoding UTF8
Get-Item "C:\tmp\result.json" | Select-Object Length  # check size
```

---

## 6. JSON Body in PowerShell — Escaping

Inline body với double-quotes bên trong:
```powershell
# ✅ Use backtick-escaped quotes inside double-quoted string
-Body "{`"studentId`":`"20225976`",`"semesterId`":`"20251`"}"

# ✅ Or use single-quoted JSON (no escaping needed)
-Body '{"studentId":"20225976","semesterId":"20251"}'
```

---

## 7. tsc Check — PowerShell Pipe

```powershell
# ❌ Wrong
npx tsc --noEmit 2>&1 | head -30

# ✅ Correct
npx tsc --noEmit 2>&1 | Select-Object -First 30
# Or save to file
npx tsc --noEmit 2>&1 | Out-File "C:\tmp\tsc_out.txt"
```

---

## 8. Confirmed Working API Endpoints (as of 2026-03-09)

| Endpoint | Required Params | Notes |
|---|---|---|
| `/student/study-conditions` | `studentId` | Returns `{kscs:{}, ths:{cpa, status}}` |
| `/student/kscs` | `studentId` | Returns null for graduated students |
| `/semesters` | _(none)_ | Returns all semesters list |
| `/grades` | `studentId`, `semesterId` | semesterId required |
| `/classes` | `studentId`, `semesterId` | Empty for graduated |
| `/exams` | `studentId`, `semesterId` | Empty for graduated |
| `/academicresult` | `studentId` | Returns semester metadata list |
| `/program` | `programId` | Exact ID required (not IT-E7 string) |
| `/gradebycourseid` | `studentId`, `courseId` | |
| `/teacher/research-topic` | `teacherId` | |
| `/company/research-topic` | `companyId` | |
