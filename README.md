# Vobo – Human <ins>Review</ins> for AI ~~Slop~~ Output

No matter what your AI does – text, image, sounds or video – Vobo helps you review its products before slop goes live.

Each Vobo queue receives input and output of your model and lets your reviewers check it against policy. All decisions are stored in a hashed chain of evidence and can be POSTed wherever you want.

We don't replace your eval tools. We make human review convenient, so you don't footgun yourself.

_The name comes from *visto bueno* (V°B°) — the Latin-American sign-off “seen-good”._

[vobo.dev](https://vobo.dev/?utm_source=github&utm_medium=readme&utm_campaign=repo) · [Docs](https://vobo.dev/docs/quickstart) · [X](https://x.com/voboreview) · [LinkedIn](https://linkedin.com/company/voboreview)

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache_2.0-020817)](LICENSE) [![MCP server](https://img.shields.io/badge/MCP-server-020817)](#connect-a-pipeline) [![Self-host](https://img.shields.io/badge/self--host-free-020817)](#get-started)

<!-- ask-ai:start -->
<p align="left"><sub>Ask AI about this repo</sub></p>
<p align="left">
  <a href="https://claude.ai/new?q=Read%20https%3A%2F%2Fgithub.com%2Fgetbeton%2Fvobo%20and%20https%3A%2F%2Fvobo.dev%2Fdocs%2Fquickstart.%20Help%20me%20add%20Vobo%20human%20review%20to%20my%20AI%20pipeline.%20First%20ask%20me%20what%20my%20model%20makes%20and%20who%20reviews%20it."><img src="https://img.shields.io/badge/Claude-111111?style=for-the-badge&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyBmaWxsPSIjZmZmZmZmIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGhlaWdodD0iMWVtIiBzdHlsZT0iZmxleDpub25lO2xpbmUtaGVpZ2h0OjEiIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjFlbSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU%2BQ2xhdWRlPC90aXRsZT48cGF0aCBkPSJNNC43MDkgMTUuOTU1bDQuNzItMi42NDcuMDgtLjIzLS4wOC0uMTI4SDkuMmwtLjc5LS4wNDgtMi42OTgtLjA3My0yLjMzOS0uMDk3LTIuMjY2LS4xMjItLjU3MS0uMTIxTDAgMTEuNzg0bC4wNTUtLjM1Mi40OC0uMzIxLjY4Ni4wNiAxLjUyLjEwMyAyLjI3OC4xNTggMS42NTIuMDk3IDIuNDQ5LjI1NWguMzg5bC4wNTUtLjE1Ny0uMTM0LS4wOTgtLjEwMy0uMDk3LTIuMzU4LTEuNTk2LTIuNTUyLTEuNjg4LTEuMzM2LS45NzItLjcyNC0uNDkxLS4zNjQtLjQ2Mi0uMTU4LTEuMDA4LjY1Ni0uNzIyLjg4MS4wNi4yMjUuMDYxLjg5My42ODYgMS45MDggMS40NzYgMi40OTEgMS44MzMuMzY1LjMwNC4xNDUtLjEwMy4wMTktLjA3My0uMTY0LS4yNzQtMS4zNTUtMi40NDYtMS40NDYtMi40OS0uNjQ0LTEuMDMyLS4xNy0uNjE5YTIuOTcgMi45NyAwIDAxLS4xMDQtLjcyOUw2LjI4My4xMzQgNi42OTYgMGwuOTk2LjEzNC40Mi4zNjQuNjIgMS40MTQgMS4wMDIgMi4yMjkgMS41NTUgMy4wMy40NTYuODk4LjI0My44MzIuMDkxLjI1NWguMTU4VjkuMDFsLjEyOC0xLjcwNi4yMzctMi4wOTUuMjMtMi42OTUuMDgtLjc2LjM3Ni0uOTEuNzQ3LS40OTIuNTg0LjI4LjQ4LjY4NS0uMDY3LjQ0NC0uMjg2IDEuODUxLS41NTkgMi45MDMtLjM2NCAxLjk0MmguMjEybC4yNDMtLjI0Mi45ODUtMS4zMDYgMS42NTItMi4wNjQuNzMtLjgyLjg1LS45MDQuNTQ3LS40MzFoMS4wMzNsLjc2IDEuMTI5LS4zNCAxLjE2Ni0xLjA2NCAxLjM0Ny0uODgxIDEuMTQyLTEuMjY0IDEuNy0uNzkgMS4zNi4wNzMuMTEuMTg4LS4wMiAyLjg1Ni0uNjA2IDEuNTQzLS4yOCAxLjg0MS0uMzE1LjgzMy4zODguMDkxLjM5NS0uMzI4LjgwNy0xLjk2OS40ODYtMi4zMDkuNDYyLTMuNDM5LjgxMy0uMDQyLjAzLjA0OS4wNjEgMS41NDkuMTQ2LjY2Mi4wMzZoMS42MjJsMy4wMi4yMjUuNzkuNTIyLjQ3NC42MzgtLjA3OS40ODUtMS4yMTUuNjItMS42NC0uMzg5LTMuODI5LS45MS0xLjMxMi0uMzI5aC0uMTgydi4xMWwxLjA5MyAxLjA2OCAyLjAwNiAxLjgxIDIuNTA5IDIuMzMuMTI3LjU3OC0uMzIyLjQ1NS0uMzQtLjA0OS0yLjIwNS0xLjY1Ny0uODUxLS43NDctMS45MjYtMS42MmgtLjEyOHYuMTdsLjQ0NC42NDkgMi4zNDUgMy41MjEuMTIyIDEuMDgtLjE3LjM1My0uNjA4LjIxMy0uNjY4LS4xMjItMS4zNzQtMS45MjUtMS40MTUtMi4xNjctMS4xNDMtMS45NDMtLjE0LjA4LS42NzQgNy4yNTQtLjMxNi4zNy0uNzI5LjI4LS42MDctLjQ2MS0uMzIyLS43NDcuMzIyLTEuNDc2LjM4OS0xLjkyNC4zMTUtMS41My4yODYtMS45LjE3LS42MzItLjAxMi0uMDQyLS4xNC4wMTgtMS40MzQgMS45NjctMi4xOCAyLjk0NS0xLjcyNiAxLjg0NS0uNDE0LjE2NC0uNzE3LS4zNy4wNjctLjY2Mi40MDEtLjU4OSAyLjM4OC0zLjAzNiAxLjQ0LTEuODgyLjkzLTEuMDg2LS4wMDYtLjE1OGgtLjA1NUw0LjEzMiAxOC41NmwtMS4xMy4xNDYtLjQ4Ny0uNDU2LjA2MS0uNzQ2LjIzMS0uMjQzIDEuOTA4LTEuMzEyLS4wMDYuMDA2eiI%2BPC9wYXRoPjwvc3ZnPg%3D%3D" alt="Ask Claude about this repo" height="28"></a>
  <a href="https://chatgpt.com/?q=Read%20https%3A%2F%2Fgithub.com%2Fgetbeton%2Fvobo%20and%20https%3A%2F%2Fvobo.dev%2Fdocs%2Fquickstart.%20Help%20me%20add%20Vobo%20human%20review%20to%20my%20AI%20pipeline.%20First%20ask%20me%20what%20my%20model%20makes%20and%20who%20reviews%20it."><img src="https://img.shields.io/badge/ChatGPT-111111?style=for-the-badge&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyBmaWxsPSIjZmZmZmZmIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGhlaWdodD0iMWVtIiBzdHlsZT0iZmxleDpub25lO2xpbmUtaGVpZ2h0OjEiIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjFlbSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU%2BT3BlbkFJPC90aXRsZT48cGF0aCBkPSJNOS4yMDUgOC42NTh2LTIuMjZjMC0uMTkuMDcyLS4zMzMuMjM4LS40MjhsNC41NDMtMi42MTZjLjYxOS0uMzU3IDEuMzU2LS41MjMgMi4xMTctLjUyMyAyLjg1NCAwIDQuNjYyIDIuMjEyIDQuNjYyIDQuNTY2IDAgLjE2NyAwIC4zNTctLjAyNC41NDdsLTQuNzEtMi43NTlhLjc5Ny43OTcgMCAwMC0uODU2IDBsLTUuOTcgMy40NzN6bTEwLjYwOSA4LjhWMTIuMDZjMC0uMzMzLS4xNDMtLjU3LS40MjktLjczN2wtNS45Ny0zLjQ3MyAxLjk1LTEuMTE4YS40MzMuNDMzIDAgMDEuNDc2IDBsNC41NDMgMi42MTdjMS4zMDkuNzYgMi4xODkgMi4zNzggMi4xODkgMy45NDggMCAxLjgwOC0xLjA3IDMuNDczLTIuNzYgNC4xNjN6TTcuODAyIDEyLjcwM2wtMS45NS0xLjE0MmMtLjE2Ny0uMDk1LS4yMzktLjIzOC0uMjM5LS40MjhWNS44OTljMC0yLjU0NSAxLjk1LTQuNDcyIDQuNTkxLTQuNDcyIDEgMCAxLjkyNy4zMzMgMi43MTIuOTI4TDguMjMgNS4wNjdjLS4yODUuMTY2LS40MjguNDA0LS40MjguNzM3djYuODk4ek0xMiAxNS4xMjhsLTIuNzk1LTEuNTd2LTMuMzNMMTIgOC42NThsMi43OTUgMS41N3YzLjMzTDEyIDE1LjEyOHptMS43OTYgNy4yM2MtMSAwLTEuOTI3LS4zMzItMi43MTItLjkyN2w0LjY4Ni0yLjcxMmMuMjg1LS4xNjYuNDI4LS40MDQuNDI4LS43Mzd2LTYuODk4bDEuOTc0IDEuMTQyYy4xNjcuMDk1LjIzOC4yMzguMjM4LjQyOHY1LjIzM2MwIDIuNTQ1LTEuOTc0IDQuNDcyLTQuNjE0IDQuNDcyem0tNS42MzctNS4zMDNsLTQuNTQ0LTIuNjE3Yy0xLjMwOC0uNzYxLTIuMTg4LTIuMzc4LTIuMTg4LTMuOTQ4QTQuNDgyIDQuNDgyIDAgMDE0LjIxIDYuMzI3djUuNDIzYzAgLjMzMy4xNDMuNTcxLjQyOC43MzhsNS45NDcgMy40NDktMS45NSAxLjExOGEuNDMyLjQzMiAwIDAxLS40NzYgMHptLS4yNjIgMy45Yy0yLjY4OCAwLTQuNjYyLTIuMDIxLTQuNjYyLTQuNTE5IDAtLjE5LjAyNC0uMzguMDQ3LS41N2w0LjY4NiAyLjcxYy4yODYuMTY3LjU3MS4xNjcuODU2IDBsNS45Ny0zLjQ0OHYyLjI2YzAgLjE5LS4wNy4zMzMtLjIzNy40MjhsLTQuNTQzIDIuNjE2Yy0uNjE5LjM1Ny0xLjM1Ni41MjMtMi4xMTcuNTIzem01Ljg5OSAyLjgzYTUuOTQ3IDUuOTQ3IDAgMDA1LjgyNy00Ljc1NkMyMi4yODcgMTguMzM5IDI0IDE1Ljg0IDI0IDEzLjI5NmMwLTEuNjY1LS43MTMtMy4yODItMS45OTgtNC40NDguMTE5LS41LjE5LS45OTkuMTktMS40OTggMC0zLjQwMS0yLjc1OS01Ljk0Ny01Ljk0Ni01Ljk0Ny0uNjQyIDAtMS4yNi4wOTUtMS44OC4zMUE1Ljk2MiA1Ljk2MiAwIDAwMTAuMjA1IDBhNS45NDcgNS45NDcgMCAwMC01LjgyNyA0Ljc1N0MxLjcxMyA1LjQ0NyAwIDcuOTQ1IDAgMTAuNDljMCAxLjY2Ni43MTMgMy4yODMgMS45OTggNC40NDgtLjExOS41LS4xOSAxLS4xOSAxLjQ5OSAwIDMuNDAxIDIuNzU5IDUuOTQ2IDUuOTQ2IDUuOTQ2LjY0MiAwIDEuMjYtLjA5NSAxLjg4LS4zMDlhNS45NiA1Ljk2IDAgMDA0LjE2MiAxLjcxM3oiPjwvcGF0aD48L3N2Zz4%3D" alt="Ask ChatGPT about this repo" height="28"></a>
  <a href="https://www.google.com/search?udm=50&q=Read%20https%3A%2F%2Fgithub.com%2Fgetbeton%2Fvobo%20and%20https%3A%2F%2Fvobo.dev%2Fdocs%2Fquickstart.%20Help%20me%20add%20Vobo%20human%20review%20to%20my%20AI%20pipeline.%20First%20ask%20me%20what%20my%20model%20makes%20and%20who%20reviews%20it."><img src="https://img.shields.io/badge/Gemini-111111?style=for-the-badge&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyBmaWxsPSIjZmZmZmZmIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGhlaWdodD0iMWVtIiBzdHlsZT0iZmxleDpub25lO2xpbmUtaGVpZ2h0OjEiIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjFlbSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU%2BR2VtaW5pPC90aXRsZT48cGF0aCBkPSJNMjAuNjE2IDEwLjgzNWExNC4xNDcgMTQuMTQ3IDAgMDEtNC40NS0zLjAwMSAxNC4xMTEgMTQuMTExIDAgMDEtMy42NzgtNi40NTIuNTAzLjUwMyAwIDAwLS45NzUgMCAxNC4xMzQgMTQuMTM0IDAgMDEtMy42NzkgNi40NTIgMTQuMTU1IDE0LjE1NSAwIDAxLTQuNDUgMy4wMDFjLS42NS4yOC0xLjMxOC41MDUtMi4wMDIuNjc4YS41MDIuNTAyIDAgMDAwIC45NzVjLjY4NC4xNzIgMS4zNS4zOTcgMi4wMDIuNjc3YTE0LjE0NyAxNC4xNDcgMCAwMTQuNDUgMy4wMDEgMTQuMTEyIDE0LjExMiAwIDAxMy42NzkgNi40NTMuNTAyLjUwMiAwIDAwLjk3NSAwYy4xNzItLjY4NS4zOTctMS4zNTEuNjc3LTIuMDAzYTE0LjE0NSAxNC4xNDUgMCAwMTMuMDAxLTQuNDUgMTQuMTEzIDE0LjExMyAwIDAxNi40NTMtMy42NzguNTAzLjUwMyAwIDAwMC0uOTc1IDEzLjI0NSAxMy4yNDUgMCAwMS0yLjAwMy0uNjc4eiI%2BPC9wYXRoPjwvc3ZnPg%3D%3D" alt="Ask Gemini about this repo" height="28"></a>
  <a href="https://grok.com/?q=Read%20https%3A%2F%2Fgithub.com%2Fgetbeton%2Fvobo%20and%20https%3A%2F%2Fvobo.dev%2Fdocs%2Fquickstart.%20Help%20me%20add%20Vobo%20human%20review%20to%20my%20AI%20pipeline.%20First%20ask%20me%20what%20my%20model%20makes%20and%20who%20reviews%20it."><img src="https://img.shields.io/badge/Grok-111111?style=for-the-badge&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyBmaWxsPSIjZmZmZmZmIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGhlaWdodD0iMWVtIiBzdHlsZT0iZmxleDpub25lO2xpbmUtaGVpZ2h0OjEiIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjFlbSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU%2BR3JvazwvdGl0bGU%2BPHBhdGggZD0iTTkuMjcgMTUuMjlsNy45NzgtNS44OTdjLjM5MS0uMjkuOTUtLjE3NyAxLjEzNy4yNzIuOTggMi4zNjkuNTQyIDUuMjE1LTEuNDEgNy4xNjktMS45NTEgMS45NTQtNC42NjcgMi4zODItNy4xNDkgMS40MDZsLTIuNzExIDEuMjU3YzMuODg5IDIuNjYxIDguNjExIDIuMDAzIDExLjU2Mi0uOTUzIDIuMzQxLTIuMzQ0IDMuMDY2LTUuNTM5IDIuMzg4LTguNDJsLjAwNi4wMDdjLS45ODMtNC4yMzIuMjQyLTUuOTI0IDIuNzUtOS4zODMuMDYtLjA4Mi4xMi0uMTY0LjE3OS0uMjQ4bC0zLjMwMSAzLjMwNXYtLjAxTDkuMjY3IDE1LjI5Mk03LjYyMyAxNi43MjNjLTIuNzkyLTIuNjctMi4zMS02LjgwMS4wNzEtOS4xODQgMS43NjEtMS43NjMgNC42NDctMi40ODMgNy4xNjYtMS40MjVsMi43MDUtMS4yNWE3LjgwOCA3LjgwOCAwIDAwLTEuODI5LTFBOC45NzUgOC45NzUgMCAwMDUuOTg0IDUuODNjLTIuNTMzIDIuNTM2LTMuMzMgNi40MzYtMS45NjIgOS43NjQgMS4wMjIgMi40ODctLjY1MyA0LjI0Ni0yLjM0IDYuMDIyLS41OTkuNjMtMS4xOTkgMS4yNTktMS42ODIgMS45MjVsNy42Mi02LjgxNSI%2BPC9wYXRoPjwvc3ZnPg%3D%3D" alt="Ask Grok about this repo" height="28"></a>
  <a href="https://www.perplexity.ai/search?q=Read%20https%3A%2F%2Fgithub.com%2Fgetbeton%2Fvobo%20and%20https%3A%2F%2Fvobo.dev%2Fdocs%2Fquickstart.%20Help%20me%20add%20Vobo%20human%20review%20to%20my%20AI%20pipeline.%20First%20ask%20me%20what%20my%20model%20makes%20and%20who%20reviews%20it."><img src="https://img.shields.io/badge/Perplexity-111111?style=for-the-badge&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyBmaWxsPSIjZmZmZmZmIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGhlaWdodD0iMWVtIiBzdHlsZT0iZmxleDpub25lO2xpbmUtaGVpZ2h0OjEiIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjFlbSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU%2BUGVycGxleGl0eTwvdGl0bGU%2BPHBhdGggZD0iTTE5Ljc4NSAwdjcuMjcySDIyLjVWMTcuNjJoLTIuOTM1VjI0bC03LjAzNy02LjE5NHY2LjE0NWgtMS4wOTF2LTYuMTUyTDQuMzkyIDI0di02LjQ2NUgxLjVWNy4xODhoMi44ODRWMGw3LjA1MyA2LjQ5NFYuMTloMS4wOXY2LjQ5TDE5Ljc4NiAwem0tNy4yNTcgOS4wNDR2Ny4zMTlsNS45NDYgNS4yMzRWMTQuNDRsLTUuOTQ2LTUuMzk3em0tMS4wOTktLjA4bC01Ljk0NiA1LjM5OHY3LjIzNWw1Ljk0Ni01LjIzNFY4Ljk2NXptOC4xMzYgNy41OGgxLjg0NFY4LjM0OUgxMy40Nmw2LjEwNSA1LjU0djIuNjU1em0tOC45ODItOC4yOEgyLjU5djguMTk1aDEuOHYtMi41NzZsNi4xOTItNS42MnpNNS40NzUgMi40NzZ2NC43MWg1LjExNWwtNS4xMTUtNC43MXptMTMuMjE5IDBsLTUuMTE1IDQuNzFoNS4xMTV2LTQuNzF6Ij48L3BhdGg%2BPC9zdmc%2B" alt="Ask Perplexity about this repo" height="28"></a>
  <a href="https://github.com/copilot?prompt=Read%20https%3A%2F%2Fgithub.com%2Fgetbeton%2Fvobo%20and%20https%3A%2F%2Fvobo.dev%2Fdocs%2Fquickstart.%20Help%20me%20add%20Vobo%20human%20review%20to%20my%20AI%20pipeline.%20First%20ask%20me%20what%20my%20model%20makes%20and%20who%20reviews%20it."><img src="https://img.shields.io/badge/Copilot-111111?style=for-the-badge&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyBmaWxsPSIjZmZmZmZmIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiIGhlaWdodD0iMWVtIiBzdHlsZT0iZmxleDpub25lO2xpbmUtaGVpZ2h0OjEiIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjFlbSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU%2BR2l0aHViQ29waWxvdDwvdGl0bGU%2BPHBhdGggZD0iTTE5LjI0NSA1LjM2NGMxLjMyMiAxLjM2IDEuODc3IDMuMjE2IDIuMTEgNS44MTcuNjIyIDAgMS4yLjEzNSAxLjU5Mi42NTRsLjczLjk2NGMuMjEuMjc4LjMyMy42MS4zMjMuOTU1djIuNjJjMCAuMzM5LS4xNzMuNjY5LS40NTMuODY4QzIwLjIzOSAxOS42MDIgMTYuMTU3IDIxLjUgMTIgMjEuNWMtNC42IDAtOS4yMDUtMi41ODMtMTEuNTQ3LTQuMjU4LS4yOC0uMi0uNDUyLS41My0uNDUzLS44Njh2LTIuNjJjMC0uMzQ1LjExMy0uNjc5LjMyMS0uOTU2bC43My0uOTYzYy4zOTItLjUxNy45NzQtLjY1NCAxLjU5My0uNjU0bC4wMjktLjI5N2MuMjUtMi40NDYuODEtNC4yMTMgMi4wODItNS41MiAyLjQ2MS0yLjU0IDUuNzEtMi44NTEgNy4xNDYtMi44NjRoLjE5OGMxLjQzNi4wMTMgNC42ODUuMzIzIDcuMTQ2IDIuODY0em0tNy4yNDQgNC4zMjhjLS4yODQgMC0uNjEzLjAxNi0uOTYyLjA1LS4xMjMuNDQ3LS4zMDUuODUtLjU3IDEuMTA4LTEuMDUgMS4wMjMtMi4zMTYgMS4xOC0yLjk5NCAxLjE4LS42MzggMC0xLjMwNi0uMTMtMS44NTEtLjQ2NC0uNTE2LjE2NS0xLjAxMi40MDMtMS4wNDQuOTk2YTY1Ljg4MiA2NS44ODIgMCAwMC0uMDYzIDIuODg0bC0uMDAyLjQ4Yy0uMDAyLjU2My0uMDA1IDEuMTI2LS4wMTMgMS42OS4wMDIuMzI2LjIwNC42My41MS43NjUgMi40ODIgMS4xMDIgNC44MyAxLjY1NyA2Ljk5IDEuNjU3IDIuMTU2IDAgNC41MDQtLjU1NSA2Ljk4NS0xLjY1N2EuODU0Ljg1NCAwIDAwLjUxLS43NjZjLjAzLTEuNjgyLjAwNi0zLjM3Mi0uMDc2LTUuMDUzLS4wMzEtLjU5Ni0uNTI4LS44My0xLjA0Ni0uOTk2LS41NDYuMzMzLTEuMjEyLjQ2NC0xLjg1LjQ2NC0uNjc3IDAtMS45NDItLjE1Ny0yLjk5My0xLjE4LS4yNjYtLjI1OC0uNDQ3LS42NjEtLjU3LTEuMTA4LS4zMi0uMDMyLS42NC0uMDQ5LS45Ni0uMDV6bS0yLjUyNSA0LjAxM2MuNTM5IDAgLjk3Ni40MjYuOTc2Ljk1djEuNzUzYzAgLjUyNS0uNDM3Ljk1LS45NzYuOTVhLjk2NC45NjQgMCAwMS0uOTc2LS45NXYtMS43NTJjMC0uNTI1LjQzNy0uOTUxLjk3Ni0uOTUxem01IDBjLjUzOSAwIC45NzYuNDI2Ljk3Ni45NXYxLjc1M2MwIC41MjUtLjQzNy45NS0uOTc2Ljk1YS45NjQuOTY0IDAgMDEtLjk3Ni0uOTV2LTEuNzUyYzAtLjUyNS40MzctLjk1MS45NzYtLjk1MXpNNy42MzUgNS4wODdjLTEuMDUuMTAyLTEuOTM1LjQzOC0yLjM4NS45MDYtLjk3NSAxLjAzNy0uNzY1IDMuNjY4LS4yMSA0LjIyNC40MDUuMzk0IDEuMTcuNjU3IDEuOTk1LjY1N2guMDljLjY0OS0uMDEzIDEuNzg1LS4xNzYgMi43My0xLjExLjQzNS0uNDEuNzA1LTEuNDMzLjY3NS0yLjQ3LS4wMy0uODM0LS4yNy0xLjUyLS42My0xLjgxMy0uMzktLjMzNi0xLjI3NS0uNDgyLTIuMjY1LS4zOTR6bTYuNDY1LjM5NGMtLjM2LjI5Mi0uNi45OC0uNjMgMS44MTMtLjAzIDEuMDM3LjI0IDIuMDYuNjc1IDIuNDcuOTY4Ljk1NyAyLjEzNiAxLjEwNCAyLjc3NiAxLjExaC4wNDRjLjgyNSAwIDEuNTktLjI2MyAxLjk5NS0uNjU3LjU1NS0uNTU2Ljc2NS0zLjE4Ny0uMjEtNC4yMjQtLjQ1LS40NjgtMS4zMzUtLjgwNC0yLjM4NS0uOTA2LS45OS0uMDg4LTEuODc1LjA1OC0yLjI2NS4zOTR6TTEyIDcuNjE1Yy0uMjQgMC0uNTI1LjAxNS0uODQuMDQ0LjAzLjE2LjA0NS4zMzYuMDYuNTI2bC0uMDAxLjE1OWEyLjk0IDIuOTQgMCAwMS0uMDE0LjI1Yy4yMjUtLjAyMi40MjUtLjAyNy42MTItLjAyOGguMzY2Yy4xODcgMCAuMzg3LjAwNi42MTIuMDI4LS4wMTUtLjE0Ni0uMDE1LS4yNzctLjAxNS0uNDA5LjAxNS0uMTkuMDMtLjM2NS4wNi0uNTI2YTkuMjkgOS4yOSAwIDAwLS44NC0uMDQ0eiI%2BPC9wYXRoPjwvc3ZnPg%3D%3D" alt="Ask Copilot about this repo" height="28"></a>
</p>
<!-- ask-ai:end -->

## Features

- **Anchored comments.** A comment sticks to a place in the artifact. It stays across versions until someone resolves it.
- **Data in and data out.** HTTP, MCP, and webhooks. You POST an artifact. You get a signed decision back.
- **Hotkeys.** The station is built for the keyboard. `⌘↵` ships a verdict.
- **Access control.** Admin and reviewer roles on every plan.
- **Text now, image WIP.** Sound and video are on the roadmap.
- **Retrievable traces.** Every decision is on a hash chain. You can pull the full record.

## The loop

```mermaid
flowchart TD
  create["create review"] --> open["open"]
  open -->|claim| claimed["claimed"]
  claimed -->|verdict| accepted["accepted"]
  claimed -->|verdict| rejected["rejected — awaiting version"]
  claimed -->|verdict| escalated["escalated"]
  rejected -->|submit version| open
  accepted -->|late critical| reopened["reopened — awaiting version, already shipped"]
  reopened -->|submit version| open
```

`create review` is an idempotent upsert on the caller's request id. `submit version` never creates a request. `accepted` is terminal for the round, not the request: a late critical reopens it. `/integrate` teaches the four-state pull contract.

## Get started

### Managed cloud

Sign up on [vobo.dev](https://vobo.dev/?utm_source=github&utm_medium=readme&utm_campaign=repo&utm_content=get-started).

Free is capped at 1 queue, 5 users and 1 000 reviews a month. Paid is $0.10 per human review and capped at 20 queues without seat or review caps. All integrations are free besides verbatim log drain (on the roadmap).

The LLM judge is on the roadmap. It will be free on any plan when you bring your own key. Paid will also let you use our tokens, charged per review.

Setup is in the [docs](https://vobo.dev/docs/quickstart).

### Enterprise

Open-core self-host is capped at 20 queues. If you need more than 20, write to [v@vobo.dev](mailto:v@vobo.dev) for an enterprise licence.

### Run it locally

You need Node.js 22+, [pnpm](https://pnpm.io), and Postgres.

```bash
git clone https://github.com/getbeton/vobo.git
cd vobo
pnpm install
cp .env.example .env
```

Set `AUTH_SECRET` (`openssl rand -base64 32`) and `POSTGRES_URL`. Then:

```bash
pnpm db:migrate
pnpm db:seed          # prints the admin password and API key once
pnpm dev              # http://localhost:3000
pnpm worker           # webhooks, lease expiry, SLA sweep — second process
```

`pnpm db:seed` writes one workspace, the default queue, and one project-scoped API key. Store the key. It is not shown again.

Without `RESEND_API_KEY`, magic links print to the server log. That is enough for local work.

Production topology, Railway, and DNS live in [`DEPLOY.md`](./DEPLOY.md).

## Connect a pipeline

Same contract on every path. Ids belong to the caller and must be deterministic.

| Path | Use when |
|---|---|
| **HTTP** `Bearer` on `/api/v1/reviews`, `/api/v1/versions`, `/api/v1/corrections`, `/api/v1/review`, `/api/v1/cursor` | Any pipeline |
| **MCP** `request_review`, `submit_version`, `list_reviews`, `get_review`, `get_corrections`, `get_cursor`, `set_cursor` | An agent in a terminal. Full-loop parity with HTTP |
| **Webhooks** Standard Webhooks signing, retry 10s / 60s / 180s, then DLQ | You have a server that can receive events |

A consumer with no server **pulls**. `changed_since` takes an event-id cursor that Vobo stores per API key. `awaiting_version` is the regeneration work list (`rejected` and `reopened`). Two copies of the same agent cannot drift: there is no local cursor. The four states live on [`/integrate`](./app/integrate/page.tsx).

Point the MCP server at an instance:

```bash
export VOBO_API_URL=http://localhost:3000
export VOBO_API_KEY=vobo_sk_…
pnpm mcp
```

## Community

| Channel | Best for |
|---|---|
| [vobo.dev/docs/quickstart](https://vobo.dev/docs/quickstart) | How to use the station |
| [GitHub Issues](https://github.com/getbeton/vobo/issues/) | Bugs and errors in this repo |
| [SECURITY.md](SECURITY.md) | Security problems (private report) |
| [X](https://x.com/voboreview) | Product notes |
| [LinkedIn](https://linkedin.com/company/voboreview) | Company notes |

## Contributing

Open a pull request against `staging`. Run `pnpm test` first.

Do not invent UI. The prototype in `design/` is the spec.

## License

[Apache License 2.0](./LICENSE)

## OSS tooling

These projects run the station. Thank you.

| Project | In Vobo | Links |
|---|---|---|
| [Next.js](https://nextjs.org) | The app | [repo](https://github.com/vercel/next.js) |
| [React](https://react.dev) | UI | [repo](https://github.com/facebook/react) |
| [Drizzle](https://orm.drizzle.team) | Schema and queries | [repo](https://github.com/drizzle-team/drizzle-orm) |
| [Better Auth](https://www.better-auth.com) | Sessions and magic links | [repo](https://github.com/better-auth/better-auth) |
| [MCP TypeScript SDK](https://modelcontextprotocol.io) | The MCP server | [repo](https://github.com/modelcontextprotocol/typescript-sdk) |
| [Zod](https://zod.dev) | Request and event shapes | [repo](https://github.com/colinhacks/zod) |
| [Tailwind CSS](https://tailwindcss.com) | Layout | [repo](https://github.com/tailwindlabs/tailwindcss) |
| [postgres.js](https://github.com/porsager/postgres) | Postgres client | [repo](https://github.com/porsager/postgres) |
| [pg-boss](https://github.com/timgit/pg-boss) | Jobs: webhooks, leases, SLA | [repo](https://github.com/timgit/pg-boss) |
| [Radix UI](https://www.radix-ui.com) | Accessible primitives | [repo](https://github.com/radix-ui/primitives) |
| [Lucide](https://lucide.dev) | Icons | [repo](https://github.com/lucide-icons/lucide) |
| [SWR](https://swr.vercel.app) | Client data | [repo](https://github.com/vercel/swr) |
| [Vitest](https://vitest.dev) | Tests | [repo](https://github.com/vitest-dev/vitest) |
| [approx-string-match](https://www.npmjs.com/package/approx-string-match) | Re-anchoring after a rewrite | [repo](https://github.com/robertknight/approx-string-match-js) |

---
> _VOBO Oversees Bullshit Output. 2026-singularity._
