import Yargs from "yargs";
import { version } from "../package.json";
import fs from "fs-extra";
import os from "os";
import shell from "shelljs";
import child_process from "child_process";
import axios from "axios";
import path from "path";
import request from "request";

async function downloadFile(url: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let fabReq = request.get(url);
    fabReq.pipe(fs.createWriteStream(to));
    let contentLength = 0;
    let downloaded = 0;
    fabReq.on("response", response => {
      contentLength = Number(response.headers["content-length"]);
    });
    fabReq.on("data", chunk => {
      downloaded = downloaded + chunk.length;
      let downloadPercentage = ((downloaded / contentLength) * 100).toFixed(2);
      console.info(`Download status: ${downloadPercentage}%`);
    });
    fabReq.on("complete", () => resolve());
    fabReq.on("error", err => reject(err));
  });
}

function assertHasTagName(
  value: unknown
): asserts value is { tag_name: string } {
  if (
    !(typeof value === "object" && typeof (value as any).tag_name === "string")
  ) {
    throw Error(`Property tag_name not found in ${JSON.stringify(value)}`);
  }
}

function assertIsTruthyString(value: unknown): asserts value is string {
  const isValid = typeof value === "string" && !!value;
  if (!isValid) {
    throw TypeError(
      `Expected a string of length greater than zero; Zero-length string or non-string provided: ${value}`
    );
  }
}

async function getLatestGitTag(releasesPage: string): Promise<string> {
  const resp = await axios.get(releasesPage);
  if (resp.status !== 200) {
    exit(1, `Non-200 (${resp.status}) response returned from ${releasesPage}`);
  }
  let { data } = resp;
  assertHasTagName(data);
  return data.tag_name;
}

async function spawn(
  cmd: string,
  args: string[] = [],
  opts: child_process.SpawnOptions = {}
): Promise<{
  stdout: string;
  stderr: string;
  stdCombined: string;
  code: number;
}> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let stdCombined = "";
    let code = 0;
    let child = child_process.spawn(cmd, args, opts);
    child.stdout?.on("data", data => {
      stdout = stdout + data;
      stdCombined = stdCombined + data;
    });
    child.stderr?.on("data", data => {
      stderr = stderr + data;
      stdCombined = stdCombined + data;
    });
    child.on("error", err => {
      reject(err);
    });
    child.on("exit", exitCode => {
      code = exitCode ?? code;
      resolve({ stdout, stderr, stdCombined, code });
    });
  });
}

function error(err: string | Error): Error {
  return err instanceof Error ? err : Error(err);
}

function exit(code: number, message?: string | Error): never {
  if (message) {
    let messageString = typeof message === "string" ? message : message.message;
    if (code === 0) {
      console.info(message);
    } else {
      console.error(messageString);
    }
  }
  process.exit(code);
}

async function getFabrikateVersion(): Promise<string> {
  function assertHasTagName(
    value: unknown
  ): asserts value is { tag_name: string } {
    if (
      !(
        typeof value === "object" && typeof (value as any).tag_name === "string"
      )
    ) {
      throw Error(`Property tag_name not found in ${JSON.stringify(value)}`);
    }
  }
  let fabReleases =
    "https://api.github.com/repos/microsoft/fabrikate/releases/latest";
  let latestVersion = await axios
    .get(fabReleases)
    .then(response => {
      if (response.status !== 200) {
        exit(
          1,
          `Non-200 (${response.status}) response returned from ${fabReleases}`
        );
      }
      let { data } = response;
      assertHasTagName(data);
      return data.tag_name;
    })
    .catch(err => {
      console.error(err);
      exit(1, `Error fetching releases page from ${fabReleases}`);
    });
  return latestVersion;
}

Yargs.scriptName("bedbuild")
  .version(version)
  .usage("$0 <cmd> [args]")
  .command(
    "verify_access_token",
    "Verify the required $ACCESS_TOKEN_SECRET environment variable is set",
    async (argv): Promise<void> => {
      console.info(
        "Verifying personal access token in $ACCESS_TOKEN_SECRET..."
      );
      if (!process.env.ACCESS_TOKEN_SECRET) {
        exit(1, "$ACCESS_TOKEN_SECRET not set in environment");
      }
      console.info("Verified presence of $ACCESS_TOKEN_SECRET in environment");
      exit(0);
    }
  )

  .command(
    "verify_repo",
    "Verify the required $REPO environment variable is set",
    async (argv): Promise<void> => {
      console.info("Verifying HLD/Manifest repository URL in $REPO...");
      if (!process.env.REPO) {
        exit(1, "$REPO not set in environment");
      }
      console.info("Verified presence of $REPO in environment");
      exit(0);
    }
  )

  .command(
    "init",
    "Initialize the build script",
    async (argv): Promise<void> => {
      let home = os.homedir();
      let cwd = process.cwd();
      console.info(`Copying contents of ${cwd} to ${home}`);
      await fs.copy(cwd, home).catch(err => {
        console.error(err);
        exit(1, `Error copying files in current directory to ${home}`);
      });
      exit(0, `Completed copying files project files ${home}`);
    }
  )

  .command(
    "helm_init",
    "Initalize the host helm client -- requires Helm@v2",
    async (argv): Promise<void> => {
      console.info(`Initializing helm client...`);
      let helm = shell.which("helm");
      if (!helm) {
        exit(1, "helm executable not found in $PATH");
      }
      console.info(`Found helm executable at: ${helm}`);
      console.info(`Verifying helm version...`);
      await spawn("helm", ["version"])
        .then(({ stdCombined }) => {
          if (!stdCombined.match(/SemVer:"v2/gi)) {
            exit(1, "Helm 2 not installed");
          }
        })
        .catch(err => {
          console.error(err);
          exit(1, "Error executing `helm version`");
        });
      console.info("Verified Helm 2 installation");
      await spawn("helm", ["init", "--client-only"])
        .then(({ stdCombined, code }) => {
          if (code !== 0) {
            console.error(stdCombined);
            exit(1, "non-zero exit returned from `helm init --client-only`");
          }
        })
        .catch(err => {
          console.error(err);
          exit(1, "Error executing `helm init --client-only`");
        });
      exit(0, "Successfully initialized helm client");
    }
  )

  .command(
    "get_fab_version",
    "Discover the latest version of Fabrikate",
    async (argv): Promise<void> => {
      let fabReleases =
        "https://api.github.com/repos/microsoft/fabrikate/releases/latest";
      let latestVersion = await getLatestGitTag(fabReleases).catch(err => {
        console.error(err);
        exit(1, `Error fetching releases page from ${fabReleases}`);
      });
      exit(0, latestVersion);
    }
  )

  .command(
    "download_fab",
    `Download Fabrikate binary to ${process.cwd()}`,
    async (argv): Promise<void> => {
      let platform = process.platform;
      let hostPlatform = platform.match(/windows/i)
        ? "windows"
        : platform.match(/darwin/i)
        ? "darwin"
        : platform.match(/linux/i)
        ? "linux"
        : undefined;
      if (hostPlatform === undefined) {
        exit(1, "Unable to determine host OS");
      }
      console.info(`Determined host OS: ${hostPlatform}`);
      let versionToDownload = await getFabrikateVersion().catch(err => {
        console.error(err);
        exit(1, "Error fetching latest Fabrikate version");
      });
      let fabrikateDownload = `https://github.com/microsoft/fabrikate/releases/download/${versionToDownload}/fab-v${versionToDownload}-${hostPlatform}-amd64.zip`;
      console.info(`Downloading Fabrikate from: ${fabrikateDownload}`);
      let fabWritePath = path.resolve("fab.zip");
      await downloadFile(fabrikateDownload, fabWritePath).catch(err => {
        console.error(err);
        exit(1, `Error downloading Fabrikate from ${fabrikateDownload}`);
      });
      console.info(`Unzipping ${fabWritePath}`);
      await spawn("unzip", [fabWritePath])
        .then(({ stdCombined, code }) => {
          console.info(stdCombined);
          if (code !== 0) {
            throw Error(
              `Non-zero exit code returned from 'unzip ${fabWritePath}'`
            );
          }
        })
        .catch(err => {
          console.error(err);
          exit(1, `Error unzipping ${fabWritePath}`);
        });
      exit(0, `Downloaded Fabrikate to ${fabWritePath}`);
    }
  )

  .command(
    "download_spk",
    `Download the SPK binary to ${process.cwd()}`,
    async (argv): Promise<void> => {
      const platform = process.platform;
      const hostPlatform = platform.match(/(windows|msys)/i)
        ? "win.exe"
        : platform.match(/darwin/i)
        ? "macos"
        : platform.match(/linux/i)
        ? "linux"
        : undefined;
      if (hostPlatform === undefined) {
        exit(1, "Unable to determine host OS");
      }

      const spkLatestPage =
        "https://api.github.com/repos/CatalystCode/spk/releases/latest";
      const versionToDownload = await getLatestGitTag(spkLatestPage).catch(
        err => {
          console.error(err);
          exit(1, `Error fetching releases page from ${spkLatestPage}`);
        }
      );

      console.info(`Latest SPK version: ${versionToDownload}`);
      const spkDownload = `https://github.com/CatalystCode/spk/releases/download/${versionToDownload}/spk-${hostPlatform}`;
      console.info(`Downloading spk from ${spkDownload}`);
      const spkWritePath = path.resolve("spk");
      await downloadFile(spkDownload, spkWritePath).catch(err => {
        console.error(err);
        exit(1, `Error downloading spk from ${spkDownload}`);
      });
      shell.chmod("+x", spkWritePath);
      exit(0, `Downloaded spk to ${spkWritePath}`);
    }
  )

  .command(
    "git_connect",
    `Git clone \$REPO to ${process.cwd()}`,
    async (argv): Promise<void> => {
      try {
        const repo = process.env.REPO;
        const PAT = process.env.ACCESS_TOKEN_SECRET;
        assertIsTruthyString(repo);
        assertIsTruthyString(PAT);
        if (!repo.match(/^https?/i)) {
          throw Error(
            `Invalid $REPO set. Expected an (http|https) git URL, found ${repo}`
          );
        }

        const PATBasedRepo = repo.replace(/^https?:\/\//i, `https://${PAT}@`);
        const repoName = PATBasedRepo.split("/").slice(-1)[0];

        console.info(`Cloning ${PATBasedRepo}`);
        await spawn("git", ["clone", PATBasedRepo]).catch(err => {
          console.error(err);
          throw Error(`Unable to clone ${PATBasedRepo}`);
        });

        console.info(`Pulling origin/master`);
        await spawn("git", ["pull", "origin", "master"], {
          cwd: path.resolve(repoName)
        }).catch(err => {
          console.error(err);
          throw Error(`Unable to 'git pull origin master' in ${repoName}`);
        });
      } catch (err) {
        console.error(err);
        exit(1);
      }
    }
  )
  .demandCommand().argv;
