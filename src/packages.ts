import { aptStreamConfig, configJSON, repositorySource } from "./config.js";
import { compress as streamCompress, decompress } from "@sirherobrine23/decompress";
import { googleDriver, oracleBucket } from "@sirherobrine23/cloud";
import { extendsCrypto, extendsFS } from "@sirherobrine23/extends";
import { apt, dpkg } from "@sirherobrine23/debian";
import { tmpdir } from "node:os";
import * as dockerRegistry from "@sirherobrine23/docker-registry";
import oldFs, { promises as fs } from "node:fs";
import coreHTTP, { Github } from "@sirherobrine23/http";
import streamPromise from "node:stream/promises";
import mongoDB from "mongodb";
import openpgp from "openpgp";
import stream from "node:stream";
import path from "node:path";

export interface dbStorage {
  repositoryID: string;
  restoreFile: any;
  controlFile: dpkg.debianControl;
}

export default async function main(initConfig: string|configJSON) {
  return new Promise<packageManeger>((done, reject) => {
    const pkg = new packageManeger(initConfig, (err) => {
      if (err) return reject(err);
      return done(pkg);
    });
  });
}

export class packageManeger extends aptStreamConfig {
  #collection: mongoDB.Collection<dbStorage>;
  async close() {}
  constructor(initConfig: string|configJSON, connectionCallback?: (err?: any) => void) {
    connectionCallback ||= (err) => {if(err) process.emit("warning", err);}
    super(initConfig);
    (async () => {
      const database = this.getDatabase();
      const mongoClient = await (new mongoDB.MongoClient(database.url)).connect();
      mongoClient.on("error", err => console.error(err));
      this.#collection = mongoClient.db(database.databaseName || "aptStream").collection<dbStorage>(database.collectionName || "packages");
      this.close = () => mongoClient.close();
    })().then(() => connectionCallback(), err => connectionCallback(err));
  }

  async pkgQuery(query: mongoDB.Filter<dbStorage>) {
    return this.#collection.find(query).toArray();
  }

  async createPackage(repositoryName: string, componentName: string, Arch: string, appRoot: string = "", options?: {compress?: "gz"|"xz", callback: (str: stream.Readable) => void}) {
    const repositorys = this.getRepository(repositoryName).getAllRepositorys().filter(pkg => pkg.componentName === componentName);
    if (!repositorys.length) throw new Error("Repository or Component name not exists!");
    const str = new stream.Readable({read(){}});
    const getHash = (compress?: "gz"|"xz") => extendsCrypto.createHashAsync(str.pipe(streamCompress(compress === "gz" ? "gzip" : compress === "xz" ? "xz" : "passThrough"))).then(({hash, byteLength}) => ({
      filePath: path.posix.join(componentName, "binary-"+Arch, "Packages"+(compress === "gz" ? ".gz" : compress === "xz" ? ".xz" : "")),
      fileSize: byteLength,
      sha512: hash.sha512,
      sha256: hash.sha256,
      sha1: hash.sha1,
      md5: hash.md5,
    }));
    (async () => {
      let breakLine = false;
      for (const repo of repositorys) {
        const componentName = repo.componentName || "main";
        for (const { controlFile: pkg } of await this.pkgQuery({repositoryID: repo.repositoryID, "controlFile.Architecture": Arch})) {
          let pkgHash: string;
          if (!(pkgHash = pkg.SHA1)) continue;
          if (breakLine) str.push("\n\n"); else breakLine = true;
          str.push(dpkg.createControl({
            ...pkg,
            Filename: path.posix.join("/", appRoot, "pool", componentName, `${pkgHash}.deb`).slice(1),
          }));
        }
      }
      str.push(null);
    })().catch(err => str.emit("error", err));
    if (typeof options?.callback === "function") (async () => options.callback(str.pipe(streamCompress(options.compress === "gz" ? "gzip" : options.compress === "xz" ? "xz" : "passThrough"))))().catch(err => str.emit("error", err));
    return Promise.all([getHash(), getHash("gz"), getHash("xz")]);
  }

  async createRelease(repositoryName: string, appRoot: string) {
    const source = this.getRepository(repositoryName);
    const repositorys = source.getAllRepositorys();
    const releaseDate = (new Date()).toUTCString();
    const Architectures = await this.#collection.distinct("controlFile.Architecture", {repositoryID: {$in: repositorys.map(a => a.repositoryID)}});
    const Components = Array.from(new Set(repositorys.map(rpm => rpm.componentName)));
    const MD5Sum = new Set<{hash: string, size: number, path: string}>();
    const SHA1 = new Set<{hash: string, size: number, path: string}>();
    const SHA256 = new Set<{hash: string, size: number, path: string}>();
    const SHA512 = new Set<{hash: string, size: number, path: string}>();
    for (const arch of Architectures) for (const comp of Components) (await this.createPackage(repositoryName, comp, arch, appRoot)).forEach(({fileSize, filePath, md5, sha1, sha256, sha512}) => {
      MD5Sum.add({size: fileSize, path: filePath, hash: md5});
      SHA1.add({size: fileSize, path: filePath, hash: sha1});
      SHA256.add({size: fileSize, path: filePath, hash: sha256});
      SHA512.add({size: fileSize, path: filePath, hash: sha512});
    });

    const toJSON = () => {
      if ((!Architectures.length) && (!Components.length)) throw new Error("Invalid config repository or not loaded to database!");
      return {
        Date: releaseDate,
        acquireByHash: false,
        Codename: source.getCodename(),
        Suite: source.getSuite(),
        Origin: source.getOrigin(),
        Label: source.getLabel(),
        Description: source.getDescription(),
        Architectures,
        Components,
        MD5Sum: Array.from(MD5Sum.values()),
        SHA1: Array.from(SHA1.values()),
        SHA256: Array.from(SHA256.values()),
        SHA512: Array.from(SHA512.values()),
      };
    }

    const toString = () => {
      const reljson = toJSON();
      let configString: string[] = [
        "Date: "+(reljson.Date),
        "Acquire-By-Hash: no",
        "Architectures: "+(reljson.Architectures.join(" ")),
        "Components: "+(reljson.Components.join(" ")),
      ];

      if (reljson.Codename) configString.push(`Codename: ${reljson.Codename}`);
      if (reljson.Suite) configString.push(`Suite: ${reljson.Suite}`);
      if (reljson.Origin) configString.push(`Origin: ${reljson.Origin}`);
      if (reljson.Label) configString.push(`Label: ${reljson.Label}`);
      if (reljson.Description) configString.push(`Description: ${reljson.Description}`);

      const insertHash = (name: string, hashes: typeof reljson.MD5Sum) => {
        configString.push(name+":");
        const sizeLength = hashes.at(0).size.toString().length+2;
        hashes.forEach(data => configString.push((" "+data.hash + " "+(Array((sizeLength - (data.size.toString().length))).fill("").join(" ")+(data.size.toString()))+" "+data.path)));
      }
      if (reljson.MD5Sum.length > 0) insertHash("MD5Sum", reljson.MD5Sum);
      if (reljson.SHA1.length > 0) insertHash("SHA1", reljson.SHA1);
      if (reljson.SHA256.length > 0) insertHash("SHA256", reljson.SHA256);
      if (reljson.SHA512.length > 0) insertHash("SHA512", reljson.SHA512);

      return configString.join("\n");
    }

    const inRelease = async (type: "sign"|"clearMessage" = "sign"): Promise<string> => {
      if (!(source.getCodename()||source.getSuite())) throw new Error("Required Suite or Codename to create InRelease file");
      else if (!(MD5Sum.size||SHA256.size)) throw new Error("Require MD5 or SHA256 to create InRelease file");
      const gpgSign = this.getPGPKey();
      const privateKey = gpgSign.gpgPassphrase ? await openpgp.decryptKey({privateKey: await openpgp.readPrivateKey({ armoredKey: gpgSign.privateKey.keyContent }), passphrase: gpgSign.gpgPassphrase}) : await openpgp.readPrivateKey({ armoredKey: gpgSign.privateKey.keyContent });
      const text = toString();
      if (type === "clearMessage") return Buffer.from(await openpgp.sign({
        signingKeys: privateKey,
        format: "armored",
        message: await openpgp.createMessage({text})
      }) as any).toString("utf8");
      return openpgp.sign({
        signingKeys: privateKey,
        format: "armored",
        message: await openpgp.createCleartextMessage({text})
      });
    }
    return {
      toJSON,
      toString,
      inRelease
    }
  }

  async getPackageStream(packageTarget: dbStorage) {
    const source = this.getRepository(packageTarget.repositoryID).get(packageTarget.repositoryID);
    if (!source) throw new Error("Package Source no more avaible please sync packages!");
    let saveCache: string;
    if (await this.getDataStorage()) {
      const cacheFolder = path.join(await this.getDataStorage(), "deb_cache");
      if (!(await extendsFS.exists(cacheFolder))) await fs.mkdir(cacheFolder, {recursive: true});
      const { MD5sum, SHA1, SHA256, SHA512 } = packageTarget.controlFile;
      for (const hash of ([MD5sum, SHA1, SHA256, SHA512])) {
        if (!hash) continue
        const filePath = path.join(cacheFolder, `${hash}.deb`);
        if (await extendsFS.exists(filePath)) return oldFs.createReadStream(filePath);
        else if (!saveCache) saveCache = filePath;
      }
    }

    if (source.type === "http") {
      const { url, auth: { header: headers, query } } = source;
      return coreHTTP.streamRequest(url, {headers, query}).then(src => {
        if (saveCache) src.pipe(oldFs.createWriteStream(saveCache));
        return stream.Readable.from(src);
      });
    } else if (source.type === "mirror") {
      const { debUrl } = packageTarget.restoreFile;
      return coreHTTP.streamRequest(debUrl).then(src => {
        if (saveCache) src.pipe(oldFs.createWriteStream(saveCache));
        return stream.Readable.from(src);
      });
    } else if (source.type === "github") {
      const { token } = source, { url } = packageTarget.restoreFile;
      return coreHTTP.streamRequest(url, {headers: token ? {"Authorization": "token "+token} : {}}).then(src => {
        if (saveCache) src.pipe(oldFs.createWriteStream(saveCache));
        return stream.Readable.from(src);
      });
    } else if (source.type === "oracleBucket") {
      const { authConfig } = source, { restoreFile: { path } } = packageTarget;
      const bucket = await oracleBucket.oracleBucket(authConfig);
      return bucket.getFileStream(path).then(src => {
        if (saveCache) src.pipe(oldFs.createWriteStream(saveCache));
        return stream.Readable.from(src);
      });
    } else if (source.type === "googleDriver") {
      const { clientId, clientSecret, clientToken } = source, { restoreFile: { id } } = packageTarget;
      const gdrive = await googleDriver.GoogleDriver({clientID: clientId, clientSecret, token: clientToken});
      return gdrive.getFileStream(id).then(src => {
        if (saveCache) src.pipe(oldFs.createWriteStream(saveCache));
        return stream.Readable.from(src);
      });
    } else if (source.type === "docker") {
      const { image, auth } = source, { ref, path: debPath } = packageTarget.restoreFile;
      const registry = new dockerRegistry.v2(image, auth);
      return new Promise<stream.Readable>((done, reject) => registry.extractLayer(ref).then(tar => tar.on("error", reject).on("File", entry => entry.path === debPath ? done(entry.stream) : null))).then(src => {
        if (saveCache) src.pipe(oldFs.createWriteStream(saveCache));
        return stream.Readable.from(src);
      });
    }
    throw new Error("Check package type");
  }

  async addPackage(repositoryID: string, control: dpkg.debianControl, restore: any): Promise<dbStorage> {
    if (Boolean(await this.#collection.findOne({repositoryID, controlFile: {Package: control.Package, Version: control.Version, Architecture: control.Architecture}}))) throw new Error("Package are exists in database");
    await this.#collection.insertOne({
      repositoryID,
      restoreFile: restore,
      controlFile: control
    });
    return {
      repositoryID,
      restoreFile: restore,
      controlFile: control
    };
  }

  async syncRepositorys(callback?: (error?: any, control?: dbStorage) => void) {
    const sources = this.getRepositorys().map(({repositoryManeger}) => repositoryManeger.getAllRepositorys()).flat(2);
    await this.#collection.deleteMany({repositoryID: (await this.#collection.distinct("repositoryID")).filter(key => !sources.find(d => d.repositoryID === key))})
    for (const repo of sources) await this.registerSource(repo.repositoryID, repo, callback);
  }

  async registerSource(repositoryID: string, target: repositorySource, callback?: (error?: any, control?: dbStorage) => void) {
    callback ??= (_void1, _void2) => {};
    if (target.type === "http") {
      try {
        const control = await dpkg.parsePackage(await coreHTTP.streamRequest(target.url, {headers: target.auth?.header, query: target.auth?.query}));
        callback(null, await this.addPackage(repositoryID, control, {}));
      } catch (err) {
        callback(err, null);
      }
    } else if (target.type === "oracleBucket") {
      const { authConfig, path = [] } = target;
      const bucket = await oracleBucket.oracleBucket(authConfig);
      try {
        if (path.length === 0) path.push(...((await bucket.listFiles()).filter(k => k.name.endsWith(".deb")).map(({name}) => name)));
        for (const file of path) {
          const control = await dpkg.parsePackage(await bucket.getFileStream(file));
          callback(null, await this.addPackage(repositoryID, control, {path: file}));
        }
      } catch (err) {
        callback(err, null);
      }
    } else if (target.type === "googleDriver") {
      const { clientId, clientSecret, clientToken, gIDs = [] } = target;
      const gdrive = await googleDriver.GoogleDriver({clientID: clientId, clientSecret, token: clientToken});
      if (gIDs.length === 0) gIDs.push(...((await gdrive.listFiles()).filter(rel => rel.name.endsWith(".deb")).map(({id}) => id)));
      for (const file of gIDs) {
        try {
          const control = await dpkg.parsePackage(await gdrive.getFileStream(file));
          callback(null, await this.addPackage(repositoryID, control, {id: file}));
        } catch (err) {
          callback(err, null);
        }
      }
    } else if (target.type === "github") {
      const { owner, repository, token } = target;
      const gh = await Github.GithubManeger(owner, repository, token);
      if (target.subType === "branch") {
        const { branch = (await gh.branchList()).at(0)?.name ?? "main" } = target;
        for (const { path: filePath } of (await gh.trees(branch)).tree.filter(file => file.type === "tree" ? false : file.path.endsWith(".deb"))) {
          try {
            const rawURL = new URL(path.posix.join(owner, repository, branch, filePath), "https://raw.githubusercontent.com");
            const control = await dpkg.parsePackage(await coreHTTP.streamRequest(rawURL, {headers: token ? {Authorization: `token ${token}`} : {}}));
            callback(null, await this.addPackage(repositoryID, control, {url: rawURL.toString()}));
          } catch (err) {
            callback(err, null);
          }
        }
      } else {
        const { tag = [] } = target;
        if (!tag.length) tag.push(...((await gh.tags()).map(d => d.name)));
        for (const tagName of tag) {
          try {
            const assets = (await gh.getRelease(tagName)).assets.filter(({name}) => name.endsWith(".deb"));
            for (const asset of assets) {
              const control = await dpkg.parsePackage(await coreHTTP.streamRequest(asset.browser_download_url, {headers: token ? {Authorization: `token ${token}`} : {}}));
              callback(null, await this.addPackage(repositoryID, control, {url: asset.browser_download_url}));
            }
          } catch (err) {
            callback(err, null);
          }
        }
      }
    } else if (target.type === "docker") {
      const { image, auth, tags = [] } = target;
      const registry = new dockerRegistry.v2(image, auth);
      const userAuth = new dockerRegistry.Auth(registry.image, "pull", auth);
      if (tags.length === 0) {
        const { sha256, tag } = registry.image;
        if (sha256) tags.push(sha256);
        else if (tag) tags.push(tag);
        else tags.push(...((await registry.getTags()).reverse().slice(0, 6)));
      }
      await userAuth.setup();
      for (const tag of tags) {
        const manifestManeger = new dockerRegistry.Utils.Manifest(await registry.getManifets(tag, userAuth), registry);
        const addPckage = async () => {
          for (const layer of manifestManeger.getLayers()) {
            const blob = await registry.extractLayer(layer.digest, userAuth);
            blob.on("error", err => callback(err, null)).on("File", async entry => {
              if (!(entry.path.endsWith(".deb"))) return null;
              const control = await dpkg.parsePackage(entry.stream);
              callback(null, await this.addPackage(repositoryID, control, {ref: layer.digest, path: entry.path}));
            });
            await new Promise<void>((done) => blob.on("close", done));
          }
        }
        if (manifestManeger.multiArch) {
          for (const platform of manifestManeger.platforms) {
            await manifestManeger.setPlatform(platform as any);
            await addPckage();
          }
        } else await addPckage();
      }
    } else if (target.type === "mirror") {
      const { config = [] } = target;
      const readFile = (path: string, start: number, end: number) => new Promise<Buffer>((done, reject) => {
        let buf: Buffer[] = [];
        oldFs.createReadStream(path, { start, end }).on("error", reject).on("data", (data: Buffer) => buf.push(data)).on("close", () => {done(Buffer.concat(buf)); buf = null;});
      });
      for (const aptSrc of config.filter(d => d.type === "packages")) {
        const main_url = new URL(aptSrc.src);
        const distMain = new URL(path.posix.join(main_url.pathname, "dists", aptSrc.distname), main_url);
        const release = apt.parseRelease(await coreHTTP.bufferRequestBody(distMain.toString()+"/InRelease").then(async data => (await openpgp.readCleartextMessage({cleartextMessage: data.toString()})).getText()).catch(() => coreHTTP.bufferRequestBody(distMain.toString()+"/Release").then(data => data.toString())));
        for (const Component of release.Components) for (const Arch of release.Architectures.filter(arch => arch !== "all")) {
          for (const ext of (["", ".gz", ".xz"])) {
            const mainReq = new URL(path.posix.join(distMain.pathname, Component, `binary-${Arch}`, `Packages${ext}`), distMain);
            const tmpFile = (path.join(tmpdir(), Buffer.from(mainReq.toString(), "utf8").toString("hex")))+".package";
            try {
              await streamPromise.finished((await coreHTTP.streamRequest(mainReq)).pipe(decompress()).pipe(oldFs.createWriteStream(tmpFile)));
              const packagesLocation: {start: number, end: number}[] = [];
              let start: number = 0, currentChuck = 0;
              await streamPromise.finished(oldFs.createReadStream(tmpFile).on("data", (chunk: Buffer) => {
                for (let i = 0; i < chunk.length; i++) if ((chunk[i - 1] === 0x0A) && (chunk[i] === 0x0A)) {
                  packagesLocation.push({
                    start,
                    end: i + currentChuck,
                  });
                  start = (i + currentChuck)+1;
                }
                currentChuck += Buffer.byteLength(chunk, "binary");
              }));
              for (const { start, end } of packagesLocation) {
                const control = dpkg.parseControl(await readFile(tmpFile, start, end));
                callback(null, await this.addPackage(repositoryID, control, {
                  debUrl: (new URL(path.posix.join(main_url.pathname, control.Filename), main_url)).toString()
                }));
              }
              await fs.rm(tmpFile);
              break;
            } catch (err) {
              callback(err, null);
            }
          }
        }
      }
    }
  }
}