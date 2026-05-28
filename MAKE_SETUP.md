# Make.com setup (no terminal)

## 1) Create webhook in Make
- Open Make.com and create a new Scenario.
- Add module: **Webhooks → Custom webhook**.
- Click **Add** and copy generated URL.

## 2) Send to Telegram from Make
- Add next module: **Telegram Bot → Send a Text Message or a Reply**.
- Connect your bot in Make (token is stored in Make, not on your site).
- Map fields from webhook payload:
  - `name`
  - `phone`
  - `message`
  - `source`

Recommended message template:

`🎨 Новая заявка с сайта`

`Имя: {{1.name}}`
`Телефон: {{1.phone}}`
`Проект: {{1.message}}`
`Источник: {{1.source}}`

## 3) Put webhook URL into site
- In `index.html`, find form:
  - `<form id="orderForm" ... data-endpoint="...">`
- Replace placeholder with your real Make webhook URL.

## 4) Turn Scenario ON
- Enable scheduling switch (Scenario ON), then test form from the site.

## Notes
- Keep Telegram token only in Make connection settings.
- Do not store token in frontend JS/HTML.
