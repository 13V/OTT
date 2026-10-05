# OTT design audit — 6 October 2026

The clay character, cream canvas, orange accent and bold typography are worth
keeping. The largest opportunity is to make the app's next action and package
information easier to scan, while using the artwork to support those tasks.

Reviewed the published homepage, app Home, Plans, prelaunch eSIM empty state,
sample eSIM state and Help. Visual review covered 1440 × 900 desktop and
390 × 844 phone screens; app Home was also checked at 2538 × 1299. The desktop
layout release is now deployed. Its former floating preview card is resolved.

This was initially a visual and source audit. At audit time no application files were changed, no wallet
was connected and no order or payment was submitted. Funded and real connected
account screens were not visually reviewed in this audit. These recommendations
are design judgments, not measured conversion results or a full accessibility
certification.

| Priority | Finding | Recommended change | Why it helps |
| --- | --- | --- | --- |
| High | Home emphasizes Connect wallet before launch; the usable app preview is lower down. The public homepage emphasizes Check launch status. | Make Try the app preview the primary app action and give the homepage a clear Explore app action. Keep programme status visible as a compact secondary link. When accounts are live, prioritize the next useful account task rather than Wallet settings. | The strongest visual emphasis leads to something useful in the current state. |
| High | Plans shows 1 GB, 5 GB and 10 GB on its size selectors; price and validity are visible only for the selected option. | Show GB, days and required credit on every option. Keep one selected summary and one Review package action. | Visitors can compare the existing catalogue without opening each option. |
| High | Desktop Plans and eSIMs give roughly 62% of their grid columns to artwork. On phone eSIMs, the illustration precedes the account or empty-state action. | Give plan/account controls more space; use a smaller contextual illustration on these screens. Put eSIMs and their actions before artwork on phones. Keep the larger scenes on the public homepage and app Home. | The app becomes easier to use without losing its visual identity. |
| Medium | The website header uses a plain text wordmark; the app uses an orange clay logo. Square hero buttons, rounded gradient buttons and dark eSIM buttons have different treatments. | Choose a shared header wordmark and define consistent primary and secondary button styles. Keep the SIM pass shape as a distinctive card treatment. Point the app logo to app Home; retain the separate website link. | Moving between the website and app feels continuous, and navigation is more predictable. |
| Medium | The small header says Prelaunch or Sample preview, but the explanatory state notice and Exit preview appear after screen content. | Add a compact explanation near each screen heading, with Exit preview nearby. Preserve explicit Sample eSIM labels on individual sample cards. | State and available actions remain clear before visitors read the whole screen. |
| Medium | Help shows progress as 1, 2, 3, 4. Functional screens use large, friendly headings above another task heading. | Add visible short step names or Step 1 of 4 next to the current step title. Use more compact headings on Plans, eSIMs and Help. Make the last guide action fit whether a real eSIM or sample account exists. | Visitors can understand progress and reach the instructions sooner. Opening a guide must still never imply successful phone installation. |
| Medium | Phone status text is 9 px at 390 px width, and drops to 8 px at the smallest breakpoint. Setup instructions use 13 px; several utility descriptions use 11 px. | Aim for 14–16 px supporting prose and at least 12 px short metadata. Reclaim room through concise wording and spacing. Keep tap targets large. | Essential text is easier to read; color contrast alone does not fix small type. |
| Medium | At 1440 × 900, the homepage hero is 944 px tall; the detailed sample account starts roughly 6007 px down the page. | Put a compact app preview or direct demo invitation earlier. Retain the story but trim repeated introductory copy and make each large scene earn its space. | Visitors see the practical product sooner, while the existing navigation still provides a direct app route. |

**Suggested order:** first update the state-specific actions, plan comparison
and functional-page layout. Then unify components, move state context upward,
and refine Help and phone typography. Review the longer homepage progression
after those product screens are clearer.

**Keep the existing strengths:** the website and app already share their core
palette and font families. Secondary text on cream has approximately 6.30:1
calculated contrast. Keyboard focus outlines, reduced-motion handling and clear
sample labels already exist. The corrected desktop Home alignment should remain.

**Follow-on check:** the real connected eSIM route delegates to the older My data
dashboard. Source shows holding/allocation information ahead of eSIM management.
Review that screen with an authorized test account before claiming a consistent
live-account experience; prioritize eSIM setup and compact credit information,
with detailed holdings progressively disclosed. This finding is source-based.

**Implementation references:**

| Area | Source |
| --- | --- |
| Homepage actions and progression | [home.js:29](C:/Users/troyw/OneDrive/Documents/ChatGPT/OTT/site/home.js:29), [home.js:317](C:/Users/troyw/OneDrive/Documents/ChatGPT/OTT/site/home.js:317) |
| App Home actions | [mobile-app.js:293](C:/Users/troyw/OneDrive/Documents/ChatGPT/OTT/site/mobile-app.js:293) |
| Visible plan comparison | [mobile-app.js:367](C:/Users/troyw/OneDrive/Documents/ChatGPT/OTT/site/mobile-app.js:367) |
| Functional-page layout | [mobile-app.css:48](C:/Users/troyw/OneDrive/Documents/ChatGPT/OTT/site/mobile-app.css:48), [mobile-app.css:155](C:/Users/troyw/OneDrive/Documents/ChatGPT/OTT/site/mobile-app.css:155), [mobile-app.js:427](C:/Users/troyw/OneDrive/Documents/ChatGPT/OTT/site/mobile-app.js:427) |
| Header identity and state context | [index.html:30](C:/Users/troyw/OneDrive/Documents/ChatGPT/OTT/site/index.html:30), [mobile-app.js:552](C:/Users/troyw/OneDrive/Documents/ChatGPT/OTT/site/mobile-app.js:552), [mobile-app.js:585](C:/Users/troyw/OneDrive/Documents/ChatGPT/OTT/site/mobile-app.js:585) |
| Help progress | [mobile-app.js:472](C:/Users/troyw/OneDrive/Documents/ChatGPT/OTT/site/mobile-app.js:472) |
| Small text | [mobile-app.css:311](C:/Users/troyw/OneDrive/Documents/ChatGPT/OTT/site/mobile-app.css:311), [mobile-app.css:348](C:/Users/troyw/OneDrive/Documents/ChatGPT/OTT/site/mobile-app.css:348), [mobile-app.css:408](C:/Users/troyw/OneDrive/Documents/ChatGPT/OTT/site/mobile-app.css:408) |
| Connected dashboard follow-on | [mobile-app.js:437](C:/Users/troyw/OneDrive/Documents/ChatGPT/OTT/site/mobile-app.js:437), [esim.js:691](C:/Users/troyw/OneDrive/Documents/ChatGPT/OTT/site/esim.js:691) |

**Captured evidence:**

- [Homepage desktop](C:/Users/troyw/.codex/visualizations/2026/10/06/ott-design-audit/homepage-desktop.jpg) and [phone](C:/Users/troyw/.codex/visualizations/2026/10/06/ott-design-audit/homepage-phone.jpg)
- [App Home desktop](C:/Users/troyw/.codex/visualizations/2026/10/06/ott-design-audit/app-home-desktop.jpg), [wide desktop](C:/Users/troyw/.codex/visualizations/2026/10/06/ott-design-audit/app-home-wide-desktop.jpg) and [phone](C:/Users/troyw/.codex/visualizations/2026/10/06/ott-design-audit/app-home-phone.jpg)
- [Plans desktop](C:/Users/troyw/.codex/visualizations/2026/10/06/ott-design-audit/plans-desktop.jpg) and [phone](C:/Users/troyw/.codex/visualizations/2026/10/06/ott-design-audit/plans-phone.jpg)
- [eSIM empty state desktop](C:/Users/troyw/.codex/visualizations/2026/10/06/ott-design-audit/esims-desktop.jpg), [phone](C:/Users/troyw/.codex/visualizations/2026/10/06/ott-design-audit/esims-phone.jpg) and [sample account phone](C:/Users/troyw/.codex/visualizations/2026/10/06/ott-design-audit/esims-sample-phone.jpg)
- [Help desktop](C:/Users/troyw/.codex/visualizations/2026/10/06/ott-design-audit/help-desktop.jpg) and [phone](C:/Users/troyw/.codex/visualizations/2026/10/06/ott-design-audit/help-phone.jpg)

When implementing, verify comparison content comes from the actual catalogue,
sample routes create no real orders, state-specific actions respect the purchase
gate, focus and bottom navigation stay usable, and app asset versions update for
returning browsers. Recheck the changed views at 1440 and 2538 px desktop widths
and 320, 360 and 390 px phone widths, then run the relevant existing browser tests.

## Implemented follow-up

The user approved the changes on 6 October. The homepage now opens the app
directly from its primary prelaunch action and has a shorter hero. App Home
prioritizes its sample preview; wallet settings remain a secondary account task.
Every package option visibly shows its catalogue GB, days and required credit.
Plans and eSIMs give account controls the larger column, with account content
before artwork in the phone reading order. Both headers use the clay logo and
primary buttons use one solid orange treatment. App Home links remain inside
the app, with the separate website link retained on desktop.

Sample explanations and Exit preview now precede each screen's content.
Functional headings are compact; Help uses one task heading, named step buttons,
Step N of 4 and a final destination appropriate to the current app state. Phone
status, supporting text and guide instructions are larger. Bottom tabs use the
full phone width. Public asset versions and service-worker cache v6 update the
release for returning browsers without caching account or financial requests.

Validation: all 109 browser tests, syntax/config lint and 15 live prelaunch checks
passed. Four phone navigation/layout tests also passed after the final navigation
adjustment. Visual checks covered the homepage and app at 1440 px, app Home at
2538 px and phone layouts at 320, 360 and 390 px. No funds or real orders moved.
The real connected dashboard follow-on and paid physical-phone test remain open.
