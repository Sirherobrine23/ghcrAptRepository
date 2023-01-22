#!/usr/bin/env node
import coreUtils, { googleDriver, httpRequest, httpRequestGithub } from "@sirherobrine23/coreutils";
import { aptSConfig, repositoryFrom, configManeger, saveConfig } from "./configManeger.js";
import { packageManeger, loadRepository } from "./packageRegister.js";
import { promises as fs } from "node:fs";
import { format } from "node:util";
import express, { Express, Router } from "express";
import inquirer from "inquirer";
import openpgp from "openpgp";
import mongoDB from "mongodb";
import cluster from "node:cluster";
import aptRoute from "./aptRoute.js";
import yargs from "yargs";
import path from "node:path";
import yaml from "yaml";
import ora from "ora";
import os from "node:os";
import "./log.js";

function getExpressRoutes(app: Express|Router) {
  const routes = [];
  function print(path: any, layer: any) {
    function split(thing: any) {
      if (typeof thing === "string") return thing.split("/");
      else if (thing.fast_slash) return "";
      else {
        var match = thing.toString().replace("\\/?", "").replace("(?=\\/|$)", "$").match(/^\/\^((?:\\[.*+?^${}()|[\]\\\/]|[^.*+?^${}()|[\]\\\/])*)\$\//)
        return match ? match[1].replace(/\\(.)/g, "$1").split("/") : "<complex:" + thing.toString() + ">"
      }
    }

    if (layer.route) layer.route.stack.forEach(print.bind(null, path.concat(split(layer.route.path))));
    else if (layer.name === "router" && layer.handle.stack) layer.handle.stack.forEach(print.bind(null, path.concat(split(layer.regexp))));
    else if (layer.method) routes.push({
      method: layer.method.toUpperCase(),
      path: path.concat(split(layer.regexp)).filter(Boolean).join("/")
    });
  }
  app?.["_router"]?.stack?.forEach(print.bind(null, []));
  return routes.filter(route => route.path !== "*") as { method: string, path: string }[];
}

yargs(process.argv.slice(2)).alias("h", "help").strictCommands().option("config", {
  alias: "C",
  type: "string",
  default: "apts.yaml",
  description: "Path to config file"
}).command("server", "Start server", async yargs => {
  const options = yargs.strict().option("port", {
    alias: "p",
    type: "number",
    default: 3000,
    description: "Port to listen on"
  }).option("cluster", {
    description: "Number to user in cluster mode, defaults to half of the number of CPUs, to disable set to negative numbers",
    type: "number",
    alias: "c",
    default: os.cpus().length,
  }).option("disable_tracer", {
    description: "Disable tracer for requests errors",
    type: "boolean",
    default: (process.env.DISABLE_TRACER === "true")
  }).parseSync();
  const config = await configManeger(options.config);
  const clusterSpawn = Number(config?.server?.cluster ?? options.cluster);
  if (clusterSpawn > 1) {
    if (cluster.isPrimary) {
      console.log("Main cluster maneger, PID %d started", process.pid);
      cluster.on("error", err => {
        console.log(err?.stack ?? String(err));
        // process.exit(1);
      }).on("exit", (worker, code, signal: NodeJS.Signals) => {
        // if (process[Symbol.for("ts-node.register.instance")]) cluster.setupPrimary({/* Fix for ts-node */ execArgv: ["--loader", "ts-node/esm"]});
        if (signal === "SIGKILL") return console.log("Worker %d was killed", worker?.id ?? "No ID");
        else if (signal === "SIGABRT") return console.log("Worker %d was aborted", worker?.id ?? "No ID");
        else if (signal === "SIGTERM") return console.log("Worker %d was terminated", worker?.id ?? "No ID");
        console.log("Worker %d died with code: %s, Signal: %s", worker?.id ?? "No ID", code, signal ?? "No Signal");
        cluster.fork();
      });
      for (let i = 0; i < clusterSpawn; i++) {
        console.log("Forking worker %d", i);
        cluster.fork().on("message", (msg) => console.log("Worker %d sent message: %o", i, msg));
      }
      return;
    }
    const id = cluster.worker?.id ?? "No ID", { pid } = process;
    console.log("Worker %d started, Node PID %f", id, pid);
  }

  // Process catch rejects
  process.on("unhandledRejection", err => console.error("Rejections Err: %s", err));
  process.on("uncaughtException", err => console.error("Uncaught Err: %s", err));

  // Main app
  let connectionCount = 0;
  const app = express();
  app.disable("x-powered-by").disable("etag").use(express.json()).use(express.urlencoded({ extended: true })).use((req, res, next) => {
    let ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    if (Array.isArray(ip)) ip = ip[0];
    if (ip.slice(0, 7) === "::ffff:") ip = ip.slice(7);
    res.setHeader("Access-Control-Allow-Origin", "*").setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE").setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.json = (body) => {
      res.setHeader("Content-Type", "application/json");
      Promise.resolve(body).then((data) => res.send(JSON.stringify(data, (_, value) => {
        if (typeof value === "bigint") return value.toString();
        return value;
      }, 2)));
      return res;
    }

    const baseMessage = "Method: %s, IP: %s, Path: %s";
    const reqDate = new Date();
    const { method, path: pathLocal } = req;
    console.info(baseMessage, method, ip, pathLocal);
    res.once("close", () => {
      connectionCount--;
      const endReqDate = new Date();
      return console.info(`${baseMessage}, Code: %f, Response seconds: %f, `, method, ip, pathLocal, res.statusCode ?? null, endReqDate.getTime() - reqDate.getTime());
    });
    connectionCount++;
    next();
  });

  // Host info
  app.get("/", async ({res}) => {
    const clusterID = cluster.isPrimary ? "Primary" : `Worker ${cluster.worker?.id ?? "No ID"}`;
    res.json({
      cpuCores: String(os.cpus().length || "Unknown"),
      system: process.platform || "Unknown",
      arch: String(os.arch() || "Unknown"),
      nodeVersion: process.version || "Unknown",
      connectionCount,
      clusterInfo: {
        isCluster: cluster.isWorker,
        clusterID,
      }
    });
  });

  // Package Maneger
  const package_maneger = await packageManeger(config);

  // APT Route
  const aptRoutes = await aptRoute(package_maneger, config);
  app.use("/apt", aptRoutes).use(aptRoutes);

  // 404 and err handler
  app.use((req, res) => res.status(404).json({
    error: "Not Found",
    path: path.posix.resolve(req.path),
    method: req.method,
    routes: getExpressRoutes(app),
  })).use((err, req, res, _next) => {
    const tracerObj = {};
    Error.captureStackTrace(tracerObj);
    const tracer = (String(err?.stack ?? tracerObj["stack"])).split("\n");
    const errorObject = {
      error: "Internal Server Error",
      message: err?.message ?? String(err),
      toDevelop: {
        req: {
          path: req.path,
          method: req.method,
          headers: req.headers,
        },
        tracer: !options.disable_tracer ? tracer : "Disabled",
        routes: getExpressRoutes(app),
      }
    };

    console.error("Server catch error:\n", errorObject);
    return res.status(500).json(errorObject);
  });

  // Listen
  const serverPort = Number(process.env.PORT ?? config?.server?.portListen ?? options.port);
  app.listen(serverPort, function() {
    console.log("Server listen port %s", (this.address() as any).port);
  });
}).command("base64", "Convert config in base64 string", async yargs => {
  const options = yargs.strict().option("json", {
    type: "boolean",
    description: "Output as json",
    default: false,
    alias: "j"
  }).option("yaml", {
    type: "boolean",
    description: "Output as yaml",
    default: false,
    alias: [
      "y",
      "yml"
    ]
  }).option("output", {
    type: "string",
    string: true,
    description: "Output file",
    alias: "o",
    default: null,
  }).parseSync();
  const baseSring = "base64:"+(Buffer.from((options.json ? JSON.stringify : yaml.stringify)(await configManeger(options.config)), "utf8").toString("base64"));
  if (options.output) await fs.writeFile(options.output, baseSring);
  return console.log(baseSring);
}).command("config", "Config maneger", async yargs => {
  const options = yargs.strict().option("create-config", {
    type: "boolean",
    description: "Create config file",
    default: false
  }).parseSync();
  let base: Partial<aptSConfig>;
  if (options.createConfig || !await coreUtils.extendFs.exists(options.config)) {
    if (!await inquirer.prompt([{type: "confirm", name: "confirm", message: "Config file does not exist, create it?", default: true}]).then(a => a.confirm)) throw new Error("Config file does not exist");
    const initialData = await inquirer.prompt<{portListen: number, cluster: number, useDatabase: boolean, pgpGen: boolean}>([
      {
        type: "input",
        name: "portListen",
        message: "Port to listen",
        default: 3000
      },
      {
        type: "input",
        name: "cluster",
        message: "Number to user in cluster mode, defaults to half of the number of CPUs, to disable set to negative numbers",
        default: os.cpus().length,
      },
      {
        type: "confirm",
        name: "pgpGen",
        message: "Generate PGP key",
        default: true
      },
      {
        type: "confirm",
        name: "useDatabase",
        message: "Use database",
        default: true
      }
    ]);
    base = {
      repositorys: {},
      server: {
        portListen: initialData.portListen,
        cluster: initialData.cluster
      }
    };
    if (initialData.pgpGen) {
      const pgpInfo = await inquirer.prompt<{name: string, email: string, password: string}>([
        {
          type: "input",
          name: "name",
          message: "You name to use in PGP key",
          default: os.userInfo().username
        },
        {
          type: "input",
          name: "email",
          message: "You email to use in PGP key",
          default: `${os.userInfo().username}@${os.hostname()}`
        },
        {
          type: "password",
          name: "password",
          message: "Password to use in PGP key, leave blank for no password",
          default: "",
          mask: "*"
        }
      ]);
      const oraGen = ora("Generating PGP key").start();
      const key = await openpgp.generateKey({
        rsaBits: 4096,
        format: "armored",
        type: "rsa",
        passphrase: pgpInfo.password.trim() ? pgpInfo.password : undefined,
        userIDs: [{
          name: pgpInfo.name,
          email: pgpInfo.email,
          comment: "Generated by apt-stream"
        }],
      });
      oraGen.succeed("Generated PGP key");
      base.server.pgp = {
        privateKey: key.privateKey,
        publicKey: key.publicKey,
        passphrase: pgpInfo.password
      };
      // write key to file
      if (await inquirer.prompt<{write: boolean}>({type: "confirm", name: "write", message: "Write key to file?", default: true}).then(a => a.write)) {
        const keyFilesName = await inquirer.prompt<{private: string, public: string}>([
          {
            type: "input",
            name: "private",
            message: "Private key file path",
            default: path.resolve(path.dirname(options.config), "pgpPrivate.key")
          },
          {
            type: "input",
            name: "public",
            message: "Public key file path",
            default: path.resolve(path.dirname(options.config), "pgpPublic.key")
          }
        ]);
        const saveSpinner = ora("Saving key to file").start();
        const resolvedPrivate = path.resolve(keyFilesName.private);
        const resolvedPublic = path.resolve(keyFilesName.public);
        await fs.writeFile(resolvedPrivate, base.server.pgp.privateKey);
        await fs.writeFile(resolvedPublic, base.server.pgp.publicKey);
        base.server.pgp.privateKey = resolvedPrivate;
        base.server.pgp.publicKey = resolvedPublic;
        saveSpinner.succeed("Saved key to file");
      }
    }

    if (initialData.useDatabase) {
      const { dbType } = await inquirer.prompt<{ dbType: aptSConfig["db"]["type"] }>({
        type: "list",
        name: "dbType",
        message: "Database type",
        choices: [
          {
            name: "MongoDB",
            value: "mongodb",
            checked: true
          },
          {
            name: "CouchDB",
            value: "couchdb"
          }
        ],
      });
      if (dbType === "mongodb") {
        const attemp = async () => {
          const { mongoURL, databaseName, collectionName } = await inquirer.prompt<{mongoURL: string, databaseName: string, collectionName: string}>([
            {
              type: "input",
              name: "mongoURL",
              message: "MongoDB URL",
              default: "mongodb://localhost:27017",
              validate(input) {
                if (!input) return "Set URL, dont leave blank";
                if (!(input.startsWith("mongodb://") || input.startsWith("mongodb+srv://"))) return "Invalid URL";
                return true;
              },
            },
            {
              type: "input",
              name: "databaseName",
              message: "Database name",
              default: "apt-stream",
              validate(input) {
                if (!input) return "Set database name, dont leave blank";
                if (input.length > 24) return "Database name must be less than 24 characters";
                return true;
              }
            },
            {
              type: "input",
              name: "collectionName",
              message: "Collection name",
              default: "packagesData",
              validate(input) {
                if (!input) return "Set collection name, dont leave blank";
                if (input.length > 64) return "Collection name must be less than 64 characters";
                return true;
              }
            }
          ]);
          base.db = {
            type: "mongodb",
            url: mongoURL,
            db: databaseName,
            collection: collectionName
          };

          try {
            const db = await (new mongoDB.MongoClient(mongoURL, { serverApi: mongoDB.ServerApiVersion.v1 })).connect();
            await db.close();
            console.log("Database connection success");
          } catch {
            console.error("Invalid database connection, retrying...");
            base.db = undefined;
            return attemp();
          }
        }
        await attemp();
      } else if (dbType === "couchdb") {
        const attemp = async () => {
          const { databaseName } = await inquirer.prompt<{couchURL: string, databaseName: string}>([
            {
              type: "input",
              name: "couchURL",
              message: "CouchDB URL",
              default: "http://localhost:5984"
            }
          ]);
          base.db = {
            type: "couchdb",
            db: databaseName
          };
        }
        await attemp();
      } else console.warn("Invalid database type, ignoring");
    }
  } else base = await configManeger(options.config);

  async function createFrom(): Promise<repositoryFrom> {
    const repoType = await inquirer.prompt({
      type: "list",
      name: "repoType",
      message: "Repository type",
      choices: [
        {
          name: "Local folder",
          value: "local"
        },
        {
          name: "Mirror APT repository",
          value: "mirror"
        },
        {
          name: "Simples HTTP/HTTPs requests",
          value: "http"
        },
        {
          name: "GitHub",
          value: "github"
        },
        {
          name: "Open container iniciative (OCI)/Docker Image",
          value: "docker"
        },
        {
          name: "Google Driver",
          value: "google_driver"
        },
        {
          name: "Oracle Cloud Bucket",
          value: "oracle_bucket"
        }
      ]
    }).then(a => a.repoType as repositoryFrom["type"]);
    console.log(repoType);
    if (repoType === "http") {
      const httpInfo = await inquirer.prompt<{url: string, requiredAuth: boolean}>([
        {
          type: "input",
          name: "url",
          message: "URL to repo",
          validate(input) {
            try {
              new URL(input);
              return true;
            } catch (err) {
              return String(err);
            }
          }
        },
        {
          type: "confirm",
          name: "requiredAuth",
          message: "Request require auth?",
          default: false
        }
      ]);
      const repo: repositoryFrom = {
        type: "http",
        url: httpInfo.url
      };
      if (httpInfo.requiredAuth) {
        const httpAuth = JSON.parse(await inquirer.prompt({
          type: "editor",
          name: "auth",
          message: "Auth data",
          default: JSON.stringify({
            headers: {},
            query: {},
          }, null, 2)
        }).then(a => a.auth));
        repo.auth = {
          header: httpAuth.headers,
          query: httpAuth.query
        };
      }
      return repo;
    } else if (repoType === "local") {
      const { folderPath } = await inquirer.prompt<{folderPath: string}>({
        type: "input",
        name: "folderPath",
        message: "Folder path"
      });
      if (!await coreUtils.extendFs.exists(folderPath)) throw new Error("Folder not found");
      return {
        type: "local",
        path: folderPath
      };
    } else if (repoType === "github") {
      let { owner, repository, token, variant } = await inquirer.prompt<{owner: string, repository: string, token?: string, variant: "repo"|"release"}>([
        {
          type: "input",
          name: "owner",
          message: "Repository owner",
          validate(input) {
            if (input.length < 1) return "Owner can't be empty";
            if (input.length > 39) return "Owner can't be longer than 39 characters";
            if (input.includes("/")) return "Owner can't include /";
            return true;
          },
        },
        {
          type: "input",
          name: "repository",
          message: "Repository name",
          validate(input) {
            if (input.length < 1) return "Repository name can't be empty";
            if (input.length > 100) return "Repository name can't be longer than 100 characters";
            if (input.includes("/")) return "Repository name can't include /";
            return true;
          }
        },
        {
          type: "password",
          name: "token",
          message: "Token"
        },
        {
          type: "list",
          name: "variant",
          message: "Variant",
          default: "release",
          choices: [
            "release",
            "repo",
          ]
        },
      ]);
      if (!token?.trim()) token = undefined;
      const gh = await coreUtils.httpRequestGithub(owner, repository, token);
      if (variant === "repo") {
        const remoteBranches = await gh.branchList().then(a => a.flat().map(b => b.name));
        const { branch } = await inquirer.prompt<{branch: string}>({
          type: "list",
          name: "branch",
          message: "Select branch",
          choices: remoteBranches,
          default: remoteBranches.at(0)
        });
        return {
          type: "github",
          subType: "branch",
          token,
          owner,
          repository,
          branch: branch ?? "master"
        };
      } else if (variant === "release") {
        const oraGetRelease = ora("Getting release tags").start();
        let releaseTags: string[] = [];
        try {
          releaseTags = await gh.getRelease().then(a => a.map(b => b.tag_name));
          oraGetRelease.succeed("Got release tags");
        } catch (err) {
          oraGetRelease.fail(format("Failed to get release tags, err: %s", err));
          throw err;
        }
        let { tag } = await inquirer.prompt<{tag: string[]}>({
          type: "checkbox",
          name: "tag",
          message: "Select tags",
          choices: releaseTags.map((a, index) => ({
            checked: index < 4,
            name: `Tag: ${a}`,
            value: a
          })),
        });
        if (tag?.length < 0) tag = undefined;
        return {
          type: "github",
          subType: "release",
          token,
          owner,
          repository,
          tag
        };
      } else throw new Error("Unknown github variant");
    } else if (repoType === "docker") {
      const { image } = await inquirer.prompt([
        {
          type: "input",
          name: "image",
          message: "Image name"
        }
      ]);
      return {
        type: "docker",
        image,
      };
    } else if (repoType === "google_driver") {
      const { client_secret, client_id } = await inquirer.prompt([
        {
          type: "input",
          name: "client_secret",
          message: "Client secret"
        },
        {
          type: "input",
          name: "client_id",
          message: "Client id"
        }
      ]);

      let inToken: string;
      const oraURL = ora("Creating url to get token").start();
      await googleDriver.GoogleDriver({
        clientID: client_id,
        clientSecret: client_secret,
        authUrl(err, data) {
          if (err) {
            oraURL.fail("Failed to create url to get token");
            throw err;
          }
          if (data.authUrl) oraURL.text = format("Open this url to get token: %s", data.authUrl);
          else oraURL.succeed(format("Got token: %s", data.token));
        },
      });

      return {
        type: "google_driver",
        app: {
          secret: client_secret,
          id: client_id,
          token: inToken
        }
      };
    } else if (repoType === "oracle_bucket") {
      console.log("Dont implement yet");
      await inquirer.prompt([
        {
          type: "input",
          name: "bucket",
          message: "Bucket name"
        },
        {
          type: "input",
          name: "namespace",
          message: "Namespace"
        },
        {
          name: "region",
          message: "Region",
          type: "input",
        },
        {
          name: "authType",
          message: "Auth type",
          type: "list",
          choices: [
            {
              name: "Preshared key (Recommended)",
              value: "preshared_key",
              checked: true
            },
            {
              name: "Public and private keys",
              value: "public_private_key"
            }
          ]
        }
      ]);;
    } else if (repoType === "mirror") {
      await inquirer.prompt([
        {
          type: "input",
          name: "url",
          message: "Url"
        },
        {
          type: "input",
          name: "component",
          message: "Component"
        },
        {
          type: "input",
          name: "distribution",
          message: "Distribution"
        }
      ]);
    }

    throw new Error("Unknown repo type");
  }

  async function addRepository(repoName?: string) {
    if (Object.keys(base.repositorys).length === 0 || !repoName) {
      const repoNameInput = await inquirer.prompt<{name: string}>({
        type: "input",
        name: "name",
        message: "Distribuition name"
      });
      repoName = repoNameInput.name;
      base.repositorys[repoName] = {from: []};
    }
    await createFrom().then(a => base.repositorys[repoName].from.push(a)).catch(a => console.error(a?.message || a));
  }

  async function changeRepository(repoName?: string) {
    await save();
    if (!repoName) {
      const { selectedToChange } = await inquirer.prompt<{selectedToChange: string}>({
        type: "list",
        name: "selectedToChange",
        message: "Select repository to change",
        choices: Object.keys(base.repositorys).map(a => ({
          name: `Repo: ${a}`,
          value: a
        }))
      });
      repoName = selectedToChange;
    }
    if (!base.repositorys[repoName]) throw new Error("Repository not found");

    const { action } = await inquirer.prompt<{action: "add"|"remove"|"edit"|"cancel"}>({
      type: "list",
      name: "action",
      message: "Select action",
      choices: [
        {name: "Add", value: "add"},
        {name: "Remove", value: "remove"},
        {name: "Edit", value: "edit"},
        {name: "Cancel", value: "cancel"},
      ]
    });
    if (action === "cancel") return;
    else if (action === "add") await createFrom().then(a => base.repositorys[repoName].from.push(a)).catch(a => console.error(a?.message || a));
    else if (action === "remove") {
      const { targetsRemove } = await inquirer.prompt<{targetsRemove: number[]}>({
        type: "checkbox",
        name: "targetsRemove",
        message: "Select targets to remove",
        choices: base.repositorys[repoName].from.map((a, index) => {
          let name = `Index ${index}: ${a.type}`;
          if (a.type === "github") {
            let targetsData = a.subType === "branch" ? a.branch : a.tag?.join(", ");
            name = `Index ${index}: Github ${a.subType} ${a.owner}/${a.repository} (${targetsData ? targetsData : "All/Fist"})`;
          } else if (a.type === "docker") name = `Index ${index}: Docker/OCI ${a.image}`;
          else if (a.type === "google_driver") name = `Index ${index}: Google driver`;
          else if (a.type === "oracle_bucket") name = `Index ${index}: Oracle bucket`;

          return {
            name,
            value: index
          };
        }),
      });
      if (targetsRemove?.length > 0) base.repositorys[repoName].from = base.repositorys[repoName].from.filter((a, index) => !targetsRemove.includes(index));
      return changeRepository(repoName);
    } else if (action === "edit") {
      const { targetsEdit } = await inquirer.prompt<{targetsEdit: number[]}>({
        type: "checkbox",
        name: "targetsEdit",
        message: "Select targets to edit",
        choices: base.repositorys[repoName].from.map((a, index) => {
          let name = `Index ${index}: ${a.type}`;
          if (a.type === "github") {
            let targetsData = a.subType === "branch" ? a.branch : a.tag?.join(", ");
            name = `Index ${index}: Github ${a.subType} ${a.owner}/${a.repository} (${targetsData ? targetsData : "All/Fist"})`;
          } else if (a.type === "docker") name = `Index ${index}: Docker/OCI ${a.image}`;
          else if (a.type === "google_driver") name = `Index ${index}: Google driver, Secret: ${a.app.secret}, Id: ${a.app.id}, Token: ${a.app.token ? "Authentificated" : "Not authentificated"}`;
          else if (a.type === "http") name = `Index ${index}: HTTP ${a.url}`;
          else if (a.type === "local") name = `Index ${index}: Local folder '${a.path}'`;
          return {
            value: index,
            name
          };
        })
      });
      if (targetsEdit.length === 0) {
        console.log("No targets selected");
        return changeRepository(repoName);
      }
      for (const index of targetsEdit) {
        const info = base.repositorys[repoName].from[index];
        if (!info) throw new Error("Target not found");
        if (info.type === "github") {
          const { owner, repository, token } = await inquirer.prompt([
            {
              type: "input",
              name: "owner",
              message: "Owner",
              default: info.owner
            },
            {
              type: "input",
              name: "repository",
              message: "Repository",
              default: info.repository
            },
            {
              type: "password",
              name: "token",
              message: "Token",
              default: info.token
            }
          ]);
          info.owner = owner;
          info.repository = repository;
          info.token = token;
          const gh = await httpRequestGithub.GithubManeger(owner, repository, token);
          if (info.subType === "branch") {
            const remoteBranches = await httpRequest.fetchJSON<{name: string}[]>({
              url: `https://api.github.com/repos/${owner}/${repository}/branches`,
              headers: token ? {Authorization: `token ${token}`} : undefined
            });
            const { branch } = await inquirer.prompt<{branch: string}>({
              type: "list",
              name: "branch",
              message: "Branch",
              choices: remoteBranches.map(a => a.name)
            });
            info.branch = branch;
          } else if (info.subType === "release") {
            const remoteTags = (await gh.getRelease()).map(a => a.tag_name);
            const { tag } = await inquirer.prompt<{tag: string[]}>({
              type: "checkbox",
              name: "tag",
              message: "Tag",
              choices: remoteTags
            });
            info.tag = tag;
          } else throw new Error("Unknown github variant");
        } else if (info.type === "docker") {
          const { image } = await inquirer.prompt<{image: string}>({
            type: "input",
            name: "image",
            message: "Image name",
            default: info.image
          });
          info.image = image;
        } else if (info.type === "google_driver") {
          const { secret, id, token } = await inquirer.prompt<{secret: string, id: string, token: string}>([
            {
              type: "input",
              name: "secret",
              message: "Client secret",
              default: info.app.secret
            },
            {
              type: "input",
              name: "id",
              message: "Client id",
              default: info.app.id
            },
            {
              type: "input",
              name: "token",
              message: "Token",
              default: info.app.token
            }
          ]);
          info.app.secret = secret;
          info.app.id = id;
          info.app.token = token;
        } else if (info.type === "http") {
          const { url } = await inquirer.prompt<{url: string}>({
            type: "input",
            name: "url",
            message: "Url",
            default: info.url
          });
          info.url = url;
        } else if (info.type === "local") {
          const { path } = await inquirer.prompt<{path: string}>({
            type: "input",
            name: "path",
            message: "Path",
            default: info.path
          });
          info.path = path;
        } else throw new Error("Unknown target type");
        base.repositorys[repoName].from[index] = info;
      }
    }
    return changeRepository(repoName).catch(err => console.log(err?.message || err));
  }

  async function save() {
    const savingSpinner = ora("Saving config").start();
    await saveConfig(base, options.config);
    savingSpinner.succeed("Saved config");
  }

  let lockSave = false;
  async function loopLoad() {
    if (lockSave) await save(); else lockSave = true;
    const distName = Object.keys(base.repositorys);
    if (distName.length === 0) {
      console.log("Init fist repository");
      return addRepository().then(() => loopLoad()).catch(() => process.exit(0));
    };
    const opte = await inquirer.prompt<{opte: string}>({
      type: "list",
      name: "opte",
      message: "Select opteration",
      default: "add",
      choices: [
        {
          name: "Add new distribution repository",
          value: "add"
        },
        {
          name: "Remove distribution repository",
          value: "remove"
        },
        {
          name: "Edit repository",
          value: "change"
        },
        {
          name: "Load packages to database",
          value: "load"
        },
        {
          name: "Exit",
          value: "cancel"
        }
      ]
    });
    if (opte.opte === "add") return addRepository().then(() => loopLoad()).catch(() => process.exit(0));
    else if (opte.opte === "change") {
      await changeRepository();
      return loopLoad();
    } else if (opte.opte === "remove") {
      const { selectedToRemove } = await inquirer.prompt<{selectedToRemove: string[]}>({
        type: "checkbox",
        name: "selectedToRemove",
        message: "Select repository to remove",
        choices: distName.map(a => ({
          name: `Repo: ${a}`,
          value: a
        }))
      });
      if (selectedToRemove.length === 0) console.log("No repository selected");
      else for (const a of selectedToRemove) delete base.repositorys[a];
      return loopLoad();
    } else if (opte.opte === "load") {
      if (!base.db?.type) return console.log("No database configured");
      const package_maneger = await packageManeger(base as aptSConfig);
      const { repoName } = await inquirer.prompt<{repoName: 1|string}>({
        type: "list",
        name: "repoName",
        message: "Select repository",
        choices: [
          {
            name: "All",
            value: 1
          },
          ...(Object.keys(base.repositorys).map(a => ({
            name: `Repo: ${a}`,
            value: a
          })))
        ]
      });

      async function load(repoName: string): Promise<any> {
        let oraLoad = ora(format("Loading packages to '%s'", repoName)).start();
        if (!base.repositorys[repoName]?.from) return oraLoad.fail(format("Failed load packages to '%s', no 'from' target", repoName));
        for (const from of base.repositorys[repoName].from) {
          if (!oraLoad) oraLoad = ora();
          oraLoad.color = "cyan";
          oraLoad.text = format("target '%s' from '%s'", repoName, from.type);
          try {
            await loadRepository({
              distName: repoName,
              packageManeger: package_maneger,
              repositoryFrom: from,
              callback(err, data) {
                if (!oraLoad) oraLoad = ora().start();
                if (err) {
                  oraLoad.fail(format("Fail add package, err: %s", err?.message || err));
                  oraLoad = undefined
                  return oraLoad;
                }
                oraLoad.text = format("Add package '%s/%s/%s' from '%s'", data.Package, data.Version, data.Architecture, from.type);
                return oraLoad;
              },
            });
            if (!oraLoad) oraLoad = ora();
            oraLoad.succeed(format("Loaded packages from '%s', target '%s'", repoName, from.type));
            oraLoad = undefined;
          } catch (err) {
            if (!oraLoad) oraLoad = ora();
            oraLoad.fail(format("Failed load packages to '%s' from target '%s', err: %s", repoName, from.type, err?.message || err));
            oraLoad = undefined;
            continue;
          }
        }
      }

      if (repoName === 1) for (const repoName of Object.keys(base.repositorys)) await load(repoName);
      else await load(repoName as string);
      console.log("Done");
      return package_maneger.close();
    }
  }
  return loopLoad();
}).parseAsync();