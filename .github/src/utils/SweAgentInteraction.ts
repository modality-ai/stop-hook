import readline from "node:readline";

enum Mode {
  Auto = "auto",
  Confirm = "confirm",
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

const DEFAULT_COMPLETION_PROMISE = "DONE";
const DEFAULT_MAX_ITERATIONS = 3;
const DEFAULT_FUNC = async (val: any, _systePromp: string) => val;
const DEFAULT_SYSTEM_PROMPT = `You're execute on PDCA (Plan-Do-Check-Act) LOOP ([CURRENT] / [MAX]) to achieve mission. When you get perfect fit, output '<promise>[PROMISE]</promise>' in your final line.`;

class SweAgent {
  protected pause = false;
  protected iteration = 0;
  private aiCommand = DEFAULT_FUNC;
  private executeCommand = DEFAULT_FUNC;
  private completionPromise: string = DEFAULT_COMPLETION_PROMISE;
  private maxIterations: number = DEFAULT_MAX_ITERATIONS;

  constructor({
    aiCommand = DEFAULT_FUNC,
    executeCommand = DEFAULT_FUNC,
    completionPromise = DEFAULT_COMPLETION_PROMISE,
    maxIterations = DEFAULT_MAX_ITERATIONS,
  } = {}) {
    this.aiCommand = aiCommand;
    this.executeCommand = executeCommand;
    if (null != completionPromise) {
      this.completionPromise = completionPromise;
    }
    if (null != maxIterations) {
      this.maxIterations = maxIterations;
    }
  }

  private extractPromise(text: string): string | null {
    const match = text.match(CONFIG.PROMISE_PATTERN);
    return match?.[1]?.trim() || null;
  }

  private getSystemPrompt(): string {
    return DEFAULT_SYSTEM_PROMPT.replace(/\[CURRENT\]/g, String(this.iteration))
      .replace(/\[MAX\]/g, String(this.maxIterations))
      .replace(/\[PROMISE\]/g, this.completionPromise);
  }

  protected async step(
    userPrompt: string | null = null,
    callback: (cmd: string) => Promise<string | undefined> = async (v) => v
  ): Promise<void> {
    this.iteration++;
    console.log(`${Colors.magenta}You: ${userPrompt}${Colors.reset}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const aiCommand = await this.aiCommand(
      userPrompt || "",
      this.getSystemPrompt()
    );
    if (this.pause) return;
    console.log(
      `${Colors.blue}Assistant (${this.iteration} / ${this.maxIterations}): ${aiCommand}${Colors.reset}`
    );
    console.log();
    console.log(
      `${Colors.magenta}----------------------------------------------------${Colors.reset}`
    );
    console.log();
    const result = await callback(aiCommand);
    if (this.pause) return;
    await this.handleCommand(result || "", userPrompt);
  }

  private async attemptCompletion(
    content: string,
    userPrompt: string | null
  ): Promise<void> {
    if (content?.trim()) {
      const lines = content.split("\n").slice(-CONFIG.PROMISE_LINES);
      for (let i = lines.length - 1; i >= 0; i--) {
        const promise = this.extractPromise(lines[i]);
        if (promise === this.completionPromise) {
          console.log(
            `${Colors.green}Promise detected: ${promise}${Colors.reset}`
          );
          return await this.step("exit");
        }
      }
    }
    if (this.iteration >= this.maxIterations) {
      console.log(
        `${Colors.yellow}Max iterations reached (${this.maxIterations}). Exiting.${Colors.reset}`
      );
      return await this.step("exit");
    } else {
      return await this.step(userPrompt);
    }
  }

  private async handleCommand(
    command: string,
    userPrompt: string | null
  ): Promise<void> {
    let content = "";
    try {
      content = await this.executeCommand(command, this.getSystemPrompt());
    } catch (error) {
      content = error instanceof Error ? error.message : String(error);
      console.error(`${Colors.red}Error: ${content}${Colors.reset}`);
    }
    await this.attemptCompletion(content, userPrompt);
  }
}

export class SweAgentInteraction extends SweAgent {
  private rl!: readline.Interface;
  private mode: Mode = Mode.Confirm;
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
      if (this.mode === Mode.Auto) {
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
      `${Colors.cyan}Commands: /h=help /a=auto /c=confirm /q=quit${Colors.reset}`
    );
    console.log();
  }

  private async promptConfirmation(): Promise<string> {
    const answer = await this.ask("Confirm? (Y/n/e)> ");
    const r = answer.trim().toLowerCase();
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
        return edited.trim() || cmd;
      }
      return cmd;
    });
  }

  async step(input: string | null = null): Promise<void> {
    if (this.pause || !input?.trim()) return;

    if (input.toLowerCase() === "exit") {
      this.isQuitting = true;
      this.rl.close();
    } else if (this.mode === Mode.Confirm) {
      await this.handleConfirmMode(input);
    } else {
      await super.step(input);
    }
  }

  async run(userPrompt?: string): Promise<void> {
    this.printHelp();
    while (true) {
      try {
        const prompt = `${Colors.green}[${this.mode === Mode.Auto ? "auto" : "input"}]>${Colors.reset} `;
        const input = userPrompt || (await this.ask(prompt));
        userPrompt = undefined;

        if (input.startsWith("/") && input.length > 1) {
          const cmd = input.slice(1).split(" ")[0];
          switch (cmd) {
            case "h":
              this.printHelp();
              break;
            case "a":
              this.mode = Mode.Auto;
              console.log(`${Colors.magenta}Auto mode${Colors.reset}`);
              break;
            case "c":
              this.mode = Mode.Confirm;
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

// new SweAgentInteraction().init("auto", "test");
