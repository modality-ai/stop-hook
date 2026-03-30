import { existsSync, writeFileSync } from "node:fs";
import readline from "node:readline";

enum Mode {
  YOLO = "yolo",
  CONFIRM = "confirm",
}

const Colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
} as const;

const CONFIG = {
  MAX_HISTORY: 1000,
  PROMISE_PATTERN: /<promise>([^<]*)<\/promise>/,
  PROMISE_LINES: 10,
} as const;

export interface AIOptions {
  systemPrompt: string;
  mode: Mode;
  currentIteration: number;
}

export const getSessionId = (): string =>
  `${((Date.now() << 10) | ((Math.random() * 1024) | 0)) >>> 0}`;

const DEFAULT_COMPLETION_PROMISE = "PDCA_LOOP_COMPLETED";
const DEFAULT_MAX_ITERATIONS = 1;
const DEFAULT_FUNC = async (val: any, _options: AIOptions) => val;
const DEFAULT_SYSTEM_PROMPT = `Follow every counter hero system instruction exactly.

You are executing PDCA (Plan-Do-Check-Act) Round [CURRENT] of [MAX].

LOOP_MD: '[LOOP_MD]'
- File is ready to use editing and rewriting, You don't need create it.
- READ '[LOOP_MD]' at the start of this round to orient yourself before acting — understand where the work stands, what has already been completed, and what the most valuable next action is for this round
- REWRITE '[LOOP_MD]' at the end of this round to capture current status and what the next round should do
- Treat it as one living document — not a log. Each round refines and consolidates it, not appends to it

Your objective: Build on prior rounds, and deliver results that exceed every previous iteration.
For each round:
- PLAN: Read '[LOOP_MD]' to understand what was done before, then identify the next highest-value action
- DO: Execute with full capability — no shortcuts, no excuses
- CHECK: Validate the result against excellence standards and prior round outcomes
- ACT: Rewrite '[LOOP_MD]' as a single improved document reflecting all progress so far, then refine for the next round

When you have achieved excellence standards, output the following as your final line: <promise>[PROMISE]</promise>`;

class SweAgent {
  protected mode: Mode = Mode.CONFIRM;
  protected pause = false;
  protected iteration = 0;
  private aiCommand = DEFAULT_FUNC;
  private executeCommand: any = null;
  private completionPromise: string = DEFAULT_COMPLETION_PROMISE;
  private maxIterations: number = DEFAULT_MAX_ITERATIONS;
  private minIterations: number = 0;
  private loopId: string;
  private loopMdPath: string;

  constructor({
    loopId = getSessionId(),
    loopMd = null,
    executeCommand = null,
    aiCommand = DEFAULT_FUNC,
    completionPromise = DEFAULT_COMPLETION_PROMISE,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    minIterations = 0,
  } = {}) {
    this.aiCommand = aiCommand;
    this.loopId = loopId;
    this.loopMdPath = loopMd || `/tmp/swe_agent_loop_${this.loopId}.md`;
    if (!existsSync(this.loopMdPath)) {
      writeFileSync(
        this.loopMdPath,
        "<!-- Initial state: no prior rounds -->\n"
      );
    }
    if (null != executeCommand) {
      this.executeCommand = executeCommand;
    }
    if (null != completionPromise) {
      this.completionPromise = completionPromise;
    }
    if (null != maxIterations) {
      this.maxIterations = maxIterations;
    }
    if (null != minIterations) {
      this.minIterations = minIterations;
    }
  }

  private extractPromise(text: string): string | null {
    const match = text.match(CONFIG.PROMISE_PATTERN);
    return match?.[1]?.trim() || null;
  }

  private getSystemPrompt(): string {
    return DEFAULT_SYSTEM_PROMPT.replace(/\[CURRENT\]/g, String(this.iteration))
      .replace(/\[MAX\]/g, String(this.maxIterations))
      .replace(/\[PROMISE\]/g, this.completionPromise)
      .replace(/\[LOOP_MD\]/g, this.loopMdPath);
  }

  protected async step(
    userPrompt: string | null = null,
    callback: (cmd: string) => Promise<string | undefined> = async (v) => v
  ): Promise<void> {
    this.iteration++;
    console.log(
      `${Colors.magenta}You (${this.iteration} / ${this.minIterations}-${this.maxIterations}): ${userPrompt}${Colors.reset}`
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    let aiCommand = await this.aiCommand(userPrompt || "", {
      systemPrompt: this.getSystemPrompt(),
      mode: this.mode,
      currentIteration: this.iteration,
    });
    if (this.pause) return;
    console.log(
      `${Colors.blue}Assistant (${this.iteration} / ${this.maxIterations}):\n ${aiCommand}${Colors.reset}`
    );
    console.log(
      `\n${Colors.magenta}----------------------------------------------------${Colors.reset}\n`
    );
    if (null != this.executeCommand) {
      aiCommand = await callback(aiCommand);
      if (this.pause) return;
    }
    await this.handleCommand(aiCommand || "", userPrompt);
  }

  private async attemptCompletion(
    content: string,
    userPrompt: string | null
  ): Promise<void> {
    if (
      "string" === typeof content &&
      content?.trim() &&
      this.iteration >= this.minIterations
    ) {
      const lines = content.split("\n").slice(-CONFIG.PROMISE_LINES);
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        const promise = this.extractPromise(line);
        if (promise && promise === this.completionPromise) {
          console.log(
            `${Colors.green}Promise detected: ${promise}${Colors.reset}`
          );
          if (this.mode === Mode.YOLO) {
            return await this.step("exit");
          }
        }
      }
    }
    if (this.mode === Mode.YOLO) {
      if (this.iteration >= this.maxIterations) {
        console.log(
          `${Colors.yellow}Max iterations reached (${this.maxIterations}). Exiting.${Colors.reset}`
        );
        return await this.step("exit");
      } else {
        return await this.step(userPrompt);
      }
    }
  }

  private async handleCommand(
    command: string,
    userPrompt: string | null
  ): Promise<void> {
    let content = command;
    if (null != this.executeCommand) {
      try {
        content = await this.executeCommand(command, this.getSystemPrompt());
      } catch (error) {
        content = error instanceof Error ? error.message : String(error);
        console.error(`${Colors.red}Error: ${content}${Colors.reset}`);
      }
    }
    await this.attemptCompletion(content, userPrompt);
  }
}

export class SweAgentInteraction extends SweAgent {
  private rl!: readline.Interface;
  private isQuitting = false;

  public init(mode?: any, userPrompt?: string): this {
    if (null != mode && Object.values(Mode).includes(mode)) {
      this.mode = mode;
    }
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    this.setupHandlers();
    this.run(userPrompt);
    return this;
  }

  public setupHandlers(): void {
    let sigintTimer: NodeJS.Timeout | undefined;
    this.rl.on("SIGINT", () => {
      clearTimeout(sigintTimer);
      console.log(`\n${Colors.yellow}Use /q to quit${Colors.reset}`);
      process.emit("SIGINT", "SIGINT");
      if (this.mode === Mode.YOLO) {
        if (!this.pause) {
          this.pause = true;
          sigintTimer = setTimeout(() => this.run(), 1000);
        } else {
          this.run();
        }
      } else {
        this.run();
      }
    });
    this.rl.on("close", () => {
      if (this.isQuitting) {
        console.log(`${Colors.green}Goodbye!${Colors.reset}`);
        process.exit(0);
      }
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });
      this.setupHandlers();
      this.run();
    });
  }

  private ask(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(prompt, (answer) => {
        resolve(answer);
      });
    });
  }

  private printHelp(): void {
    console.log(
      `\n${Colors.cyan}Commands: /h=help /a=yolo /c=confirm /q=quit${Colors.reset}\n`
    );
  }

  private async promptConfirmation(): Promise<string> {
    const answer = await this.ask("Confirm? (Y/n/e)> ");
    const r = answer?.trim().toLowerCase();
    return ["y", "n", "e", ""].includes(r) ? r : this.promptConfirmation();
  }

  private async handleConfirmMode(input: string): Promise<void> {
    await super.step(input, async (cmd) => {
      const c = await this.promptConfirmation();
      if (c === "n") {
        console.log(`${Colors.yellow}Skipping.${Colors.reset}`);
        return undefined;
      }
      if (c === "e") {
        this.rl.write(cmd);
        const edited = await this.ask("Edit: ");
        return edited?.trim() || cmd;
      }
      return cmd;
    });
  }

  async step(input: string | null = null): Promise<void> {
    if (this.pause || !input?.trim()) return;

    if (input.toLowerCase() === "exit") {
      this.isQuitting = true;
      this.rl.close();
    } else if (this.mode === Mode.CONFIRM) {
      await this.handleConfirmMode(input);
    } else {
      await super.step(input);
    }
  }

  async run(userPrompt?: string): Promise<void> {
    let init = false;
    while (true) {
      try {
        if (!init && !userPrompt) {
          this.printHelp();
          init = true;
        }
        const prompt = `${Colors.green}[${this.mode === Mode.YOLO ? "yolo" : "input"}]>${Colors.reset} `;
        const input = userPrompt || (await this.ask(prompt));
        userPrompt = undefined;

        if (input.startsWith("/") && input.length > 1) {
          const cmd = input.slice(1).split(" ")[0];
          switch (cmd) {
            case "h":
              this.printHelp();
              break;
            case "a":
              this.mode = Mode.YOLO;
              console.log(`${Colors.magenta}YOLO mode${Colors.reset}`);
              break;
            case "c":
              this.mode = Mode.CONFIRM;
              console.log(`${Colors.magenta}Confirm mode${Colors.reset}`);
              break;
            case "q":
              this.isQuitting = true;
              this.rl.close();
              break;
            default:
              console.log(`${Colors.red}Unknown: /${cmd}${Colors.reset}`);
          }
        } else {
          this.iteration = 0;
          this.pause = false;
          await this.step(input);
        }
      } catch (error) {
        console.error(
          `${Colors.red}Error: ${error instanceof Error ? error.message : error}${Colors.reset}`
        );
      }
    }
  }
}

// new SweAgentInteraction().init("yolo", "test");
