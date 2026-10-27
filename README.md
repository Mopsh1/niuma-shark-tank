# niuma 🦈

**Your agents at work, as sharks in an ASCII tank.** A [Claude Code](https://claude.com/claude-code) mod: every agent is a shark in a pane beside the chat, idle and pale until it gets a task, then lit up and swimming, tagged with what it is doing.

```
                               `
          ,                     %S,          ooo
           %;          .         ;;;%,``     XX%%
          8%ttttSttSt%SXSX%SX%XXXXS%%ttSS8SSSSttt;;.
          :%,       ,,'##XS%S%XX@@8@8%8%St%SX%S%tStt
                             ''@#@XX88S##@8@`'.%XX
                               .:%%S. .,      .X%%
                             `::,              1 Codex
```

In the pane the sharks are shaded grey blocks under dark glyphs, after [ascii-sharks](https://github.com/stackedlol/ascii-sharks).

## What it shows

| Agent | Shark | Tracked when |
|---|---|---|
| Claude subagents | mako (orange) | Claude calls its Agent tool, in the foreground or the background |
| Codex | hammerhead (blue) | a Bash call runs `codex exec`, `codex review` or `codex exec resume` |
| Antigravity | tiger shark (green) | a Bash call runs `agy -p` |

- Each agent keeps one shark in the tank. Idle, it is a pale shadow drifting about; at work it lights up, swims faster, and its tag numbers the task. Two tasks for one agent at once bring in a second shark of its own shade; when a task ends its shark swims off or goes back to idle.
- Below the tank: what each agent is doing, for how long, and its working folder. A run whose end never came can be **marked as ended** by hand.
- A line above the prompt says who is at what and opens the pane. The pane also opens by itself when a task starts, or with `/delegations`.
- The tank fills the pane, drawing less detail on a very large one so it stays light.

## Install

In a terminal session of Claude Code:

```
/plugin install niuma --marketplace Mopsh1/niuma-shark-tank
```

Answer `y` to add the marketplace, then pick a scope. In the desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `Mopsh1/niuma-shark-tank` → **Add plugin**.

Requires a Claude Code with mods (hooks modules and the `Client` element): tested on 2.1.308; 2.1.278 does not load it. The tank draws on the desktop app and in the terminal; VS Code and the mobile app show the list alone. Codex and Antigravity are optional: without them their sharks just stay idle.

## Options

Set them in `/config`, or in `settings.json` under `pluginConfigs["niuma@niuma-shark-tank"].options`.

| Option | Default | What it does |
|---|---|---|
| `summaryLanguage` | `en` | Each task's one-line title. A description already in this language is used as given; otherwise one short Haiku call writes it. `zh-TW` writes Traditional Chinese; `off` shows the description as given and calls no model. |
| `tankDensity` | `1.15` | Desktop only: how many of the tank's small-type cells fit in one pane column (1–2). Lower it if the tank's right edge is cut off, raise it if there is a gap. |

## Cost and privacy

The tank costs no tokens. The only model call is the Haiku summary above: at most one per task, none with `summaryLanguage` set to `off`. That call goes through Claude Code like any other and carries the task's description and the start of its instruction. Records of tasks are kept in Claude Code's own plugin store on your machine; niuma sends them nowhere else.

## Development

```sh
claude plugin validate .
claude plugin test .
```

`tsc -p .` type-checks once Claude Code has loaded the mod and written its types to `.claude-plugin/types/`.

The tank's look (paper colour, shark sizes, dots, speed and more) is the `LOOK` object in `hooks/tank.ts`. `tuner/` is a page that runs the same tank with a slider for each value:

```sh
node tuner/build.mjs
python3 -m http.server 8766 --directory tuner
```

Open http://localhost:8766, tune it, and copy the parameters back into `LOOK`.

## Credits and license

The shark shapes, the cell-by-cell rasterization and the shading are adapted from [ascii-sharks](https://github.com/stackedlol/ascii-sharks) by drewdi (MIT). niuma is MIT licensed; see [LICENSE](LICENSE).

---

## 繁體中文

**niuma 把你的 agent 畫成 ASCII 鯊魚缸裡的鯊魚。** 它是一個 Claude Code 的 mod：對話旁邊的面板裡，每個 agent 都是一隻鯊魚。閒置時是淡淡的影子，接到任務就亮起來、游得比較快，標籤寫著任務編號。

- **Claude 子代理**是橘色鯖鯊，**Codex** 是藍色雙髻鯊，**Antigravity** 是綠色虎鯊。
- 同一個 agent 同時做兩件事，就會多游進一隻顏色深淺不同的鯊魚；任務結束時，鯊魚會游走或回到閒置。
- 魚缸下方列出誰在做什麼、做了多久。卡住的任務可以手動按 **Mark as ended** 結束。
- 輸入框上方會顯示誰在做什麼，按 **Open** 或輸入 `/delegations` 打開面板；有任務開始時面板也會自動打開。

**安裝**：在 Claude Code 的終端機輸入 `/plugin install niuma --marketplace Mopsh1/niuma-shark-tank`。用桌面版的話，按輸入框旁的 **+** → **Plugins** → **Add marketplace**，輸入 `Mopsh1/niuma-shark-tank`，再按 **Add plugin**。

**設定**：`summaryLanguage` 可以設成 `zh-TW`，任務摘要就會用繁體中文；設成 `off` 則完全不呼叫模型。`tankDensity` 用來調整桌面版魚缸的字元密度。

鯊魚的形狀與繪製方式改寫自 drewdi 的 [ascii-sharks](https://github.com/stackedlol/ascii-sharks)（MIT 授權）。niuma 同樣採用 MIT 授權。
