# Business calendar and SLA

Canonical business timezone: configured business timezone (initial deployment Asia/Yekaterinburg). Date-only business rules вычисляются server-side через versioned BusinessCalendar.

Calendar содержит weekends/holidays/working overrides. SLA rule хранит calendar version, queue kind, severity and duration.

Изменение календаря не переписывает уже записанный dueAt без explicit recalculation job/audit.
