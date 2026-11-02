# Emulator screenshots

Captured on the `reasonix` Android emulator (API 36, 1080×2400) against a
throwaway fake kernel at `http://10.0.2.2:8799`. Every session, project, message
and attachment is synthetic: `demo`, `示例项目`, `示例会话` and a two-line
`sample.log`. No real task, prompt, token or chat content appears here.

| File | Shows |
| --- | --- |
| `01-home-connected.png` | Connected home with the dummy session |
| `02-chat-empty.png` | Empty dummy chat, light theme |
| `03-attach-sheet-light.png` | Attach sheet: camera, image, file, plan |
| `04-file-chip-light.png` | Non-image file chip and reference token |
| `05-attach-sheet-dark.png` | Attach sheet, dark theme |
| `06-file-chip-dark.png` | File chip, dark theme |
| `07-prefs-light.png` | Preferences: version, update row, diagnostics |
| `08-prefs-dark.png` | Preferences, dark theme |
| `09-approval-actions.png` | Approval notification with allow / deny / session |
| `10-question-choices.png` | Single-question notification with inline choices |
| `11-question-answered.png` | Service notice after answering 「茶」 inline |
| `16-notify-options-light.png` | Preferences with 通知里显示选项 off, light theme |
| `17-notify-options-dark.png` | Same, dark theme |
| `18-notify-answer-only.png` | Default ask notification: fixed title, full prompt, one 去回答 action |
| `19-notify-options.png` | Same ask with short inline options enabled |
| `20-notify-options-on-dark.png` | The switch on, dark theme |

The update row checked the v0.2.2 manifest from this emulator and reported the
installed build as current. Notification images use the system shade over the
same dummy session.
