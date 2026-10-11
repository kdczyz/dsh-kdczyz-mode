# backup/ —— dsh-kdczyz-mode 的整体快照

`dsh-wotr-console-1.1.0-20261011.tar.gz`（1.1 MB）是插件**全部文件的整合快照**：
解包就能拿到插件本体 + 仓库根安装壳 + 完整说明，不需要克隆仓库。

## 直接下载（其他机器用这个）

```
https://raw.githubusercontent.com/kdczyz/dsh-kdczyz-mode/main/backup/dsh-wotr-console-1.1.0-20261011.tar.gz
```

```sh
curl -fsSLO https://raw.githubusercontent.com/kdczyz/dsh-kdczyz-mode/main/backup/dsh-wotr-console-1.1.0-20261011.tar.gz
shasum -a 256 -c dsh-wotr-console-1.1.0-20261011.tar.gz.sha256   # 先校验再解包
tar -xzf dsh-wotr-console-1.1.0-20261011.tar.gz
```

## 解包里有什么

| 路径 | 说明 |
|---|---|
| `dsh-wotr-console/` | 插件本体（63 个文件）：三个 Loader 入口、浏览器端管理页、vendor 池、单测 |
| `package.json` | 仓库根的安装壳（`dsh.bundle.patch` → `./dsh-wotr-console/cordis.patch.yml`，即快照内的旧目录名） |
| `README.md` | 仓库根说明（安装 / 排错 / provider 清单 / 验证命令） |
| `README-备份说明.md` | **详细用法**：三种安装方式、装完怎么验证、快照里没有什么 |
| `MANIFEST.txt` | 66 个文件的 sha256 与字节数，可在解包目录里 `shasum -a 256 -c` 复验 |

## 三个必须知道的点

1. **账号数据不在快照里。** 号池、令牌、积分与历史记录在
   `~/.dsh/plugin-data/dsh-workbuddy-console/`（目录名**有意保留旧插件名**），
   那是本机数据，**不应该**进任何仓库。
   换机器要重新登录（浏览器扫码 / 设备码）。
2. **profile 里的 `config:` 也不在。** `~/.dsh/profiles/<profile>/cordis.patch.yml`
   里三个 entry 下面的 `config:`（登录方式、分配策略、模型勾选、区域开关）
   是每台机器自己的设置，**合并时不要覆盖**目标机器上已有的条目。
3. **宿主内包不用带。** `@deepseek-ai/*`、`@earendil-works/pi-ai` 由 DSH 运行时从
   安装目录路由给每个 profile，快照里没有、也不需要。

> 展开的那份目录（`dsh-wotr-console-1.1.0-20261011/`）在 `.gitignore` 里，只留在本机 ——
> 仓库里只放压缩包，免得每台设备走插件管理页安装时多下一份重复源码。
> 需要把展开副本也提交进仓库的话说一声。
