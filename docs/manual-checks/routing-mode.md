# Manual Check: Routing Mode (2.6.0)

## Setup
`npm start` → open http://localhost:3000 → Settings modal

## Checks

- [ ] 1. Open Settings → Маршруты. "Полный туннель" is active by default.
- [ ] 2. Description text is visible under the toggle. Tiles are dimmed. CIDR counter shows "не применяется".
- [ ] 3. Close modal. Click Generate. Config downloads — full tunnel (no presets required).
- [ ] 4. Open modal → switch to "Выборочная". Tiles become interactive. CIDR counter shows 0.
- [ ] 5. No presets selected → close modal → click Generate. Error message shown, no download, no network request sent.
- [ ] 6. Select one preset (e.g. Telegram). CIDR counter updates after ~500ms.
- [ ] 7. Close modal → Generate. Config downloads with split tunnel routing.
- [ ] 8. Open modal → select some presets → switch to "Полный туннель". Notice "Presets не будут ограничивать маршруты" appears. Tiles dim.
- [ ] 9. Switch back to "Выборочная". Previously selected presets are still checked.
- [ ] 10. Enable Mobile profile. AllowedIPs explanation shows IPv6 note.
- [ ] 11. Enable "Без лимита". AllowedIPs explanation shows no-limit warning.
- [ ] 12. Switch UI language to EN. Verify "Full tunnel", "Split tunnel", "Routing" render correctly. No `undefined` or missing key strings.
- [ ] 13. Generate config and open result summary card (ℹ️). "Режим маршрутов" shows "Весь трафик" (full) or "Выборочно" (split).
- [ ] 14. No `undefined`, `null`, `[object Object]` anywhere in UI.
