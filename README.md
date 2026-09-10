# order-profit-analysis

订单利润分析本地工具，基于 Vite + Vue 3 + Element Plus，支持按周导入订单利润表和 Listing 销售库存表、沉淀 ASIN 主数据、在浏览器中直接维护产品状态与补货信息，并导出本地仓库 PDF 清单。

## 30 秒上手

1. 运行 `npm install && npm run dev`
2. 在 `public/data/周次目录/` 放入订单利润表和 Listing销售库存表
3. 打开 `http://127.0.0.1:8000`
4. 点击“扫描并导入”
5. 点击“导入”或“全部导入”

你日常最常用的动作只有 5 个：

- 导入新周报
- 切换周次和店铺
- 直接改品名 / 产品分类 / 本地仓库 / 已下单 / 补货用时 / 备注
- 看红色风险格和黄色补货行
- 按“本地仓有货”筛选后导出 PDF 清单

## 你能用它做什么

- 扫描 `public/data/周次目录/`，按周次导入双表（订单利润 + Listing销售库存）
- 将每周表格永久保存为 JSON 快照，避免历史数据丢失
- 按店铺维护 ASIN 主数据，每个店铺一个 JSON 文件
- 支持店铺、补货状态、产品分类、库存健康四个筛选，外加 ASIN / FNSKU 搜索
- 支持父子 ASIN 折叠、固定列、列显隐和列排序
- 支持在表格内直接编辑品名、产品分类、本地仓库、已下单、补货用时、每周备注
- 支持行内展开“库存详情”，查看 FBA 明细、包装 / 外箱尺寸、重量类型，并切换整箱 / 混装
- 支持勾选多行后批量改分类、复制 ASIN、复制包装尺寸和已下单数量
- 支持“已到库”“已发出”一键流转本地仓库和已下单数量
- 支持产品分类联动：父体标记为“放弃”时，子体自动放弃并隐藏
- 自动计算 ROI、补货数量、库存健康度、重量类型
- 支持导出本地仓库 PDF 清单（含产品图片）
- 支持导入反馈、toast 提示、异常高亮、补货整行高亮、商品图片预览

## 快速开始

### 1. 安装并启动

```bash
npm install
npm run dev
```

默认地址：`http://127.0.0.1:8000`

### 2. 放入周报文件

把每周数据放到独立目录（示例）：

```text
public/data/36周(08-30~09-05)/
  订单利润-ASIN-2026-08-30~2026-09-05-955119418385620992.xlsx
  Listing销售库存_2026-08-07_2026-09-05.csv
```

订单利润表需为文件名包含“订单利润”的 `.xlsx` 文件；Listing 文件需以 `Listing销售库存` 开头，支持 `.xlsx` 和 `.csv`。周次目录名称通常含“`数字周`”，例如 `36周(08-30~09-05)`；系统会将其识别为 `36周`。周起止日期从订单利润文件名里的 `YYYY-MM-DD~YYYY-MM-DD` 提取。

同一目录里出现多个候选文件时，系统会自动挑选文件名最“干净”的那个，带“副本”或 `(1)` 的会被降权；以 `~$` 开头的 Excel 临时文件直接忽略。

为保护本地导入过程，单个导入文件不能超过 10 MB，首个工作表最多 50,000 行和 200 列；订单利润表及 Listing销售库存表都必须包含 `ASIN` 列。

### 3. 进入页面导入

- 点击顶部“扫描并导入”
- 先扫描 `public/data/` 目录
- 再手动点击“导入”或“全部导入”

注意：启动项目时不会自动导入表格。

已导入周的源文件若发生变化（订单文件换了、Listing 文件有增减、源文件修改时间晚于上次导入），扫描接口会标记为“建议重新导入”，但不会再次显示在“待导入”列表。若确实需要重导，请先在“已导入”列表删除该周快照，再重新扫描。

## 常见操作

### 导入新一周数据

1. 把新一周目录放到 `public/data/`
2. 启动项目
3. 点击“扫描并导入”
4. 点击“导入”或“全部导入”
5. 导入完成后，系统会自动切到最新周次

如果某些 ASIN 只出现在 Listing 表、订单利润表里没有，导入结束后会弹出“归属确认”面板，需要你为这些 ASIN 逐个选择店铺，确认后才会写入对应的 `products/shop-x.json`。

### 修改产品信息

可以直接在表格里修改以下字段，失焦后会实时写入 JSON：

- 品名
- 产品分类
- 本地仓库
- 已下单
- 补货用时
- 备注（按周保存，见下）

“备注”与其他字段不同，它存放在当周快照 `weeks/{weekId}.json` 的 `notes` 里，切换周次后互不影响。其余字段都存放在店铺主数据 `products/shop-x.json` 中，跨周共享。

### 展开库存详情

点击行尾的“库存详情”按钮，可以在行下方展开一块面板，包含：

- 库存健康、FNSKU、可售、入库中、不可售、预留、FBA总量
- 包装尺寸、包装类型、包装成本、外箱尺寸、最大装箱数、单品重量、重量类型
- 装箱方式（整箱 / 混装，可切换）
- 本地仓库、已下单、补货用时（可直接编辑）
- 补货数量、产品图片

面板底部有两个按钮：

- **已到库**：把“已下单”的数量加进“本地仓库”，并把“已下单”清零
- **已发出**：把“本地仓库”清零

### 批量操作

勾选表格左侧的复选框后，工具栏上的批量动作会启用：

- **批量改分类**：把选中的所有 ASIN 改为同一个产品分类
- **复制包装尺寸+已下单**：把选中 ASIN 的包装尺寸和已下单数量复制到剪贴板
- **清空勾选**：取消所有选择

另有一个不依赖勾选的按钮：**复制非放弃ASIN**，复制当前筛选结果里所有非“放弃”的 ASIN。

### 导出本地仓库 PDF

导出按钮有两个前置条件，任一不满足时按钮禁用并提示原因：

1. 店铺筛选选中了单个店铺，不能是“全部”
2. 补货筛选切换到“本地仓有货”

导出的 A4 表格包含：产品图片（多图）、品名、FNSKU、本地仓库、包装尺寸、单品重量、重量类型、包装类型、备注。文件名格式为 `{周次}-{店铺导出名}-本地仓库.pdf`，店铺导出名取 `shops.json` 里的 `mdExportName`。

### 标记不再经营的产品

把产品分类改为“放弃”后：

- 当前产品会从主表格隐藏
- 如果改的是父 ASIN，则同店铺下的子 ASIN 会一起改为“放弃”
- 数据仍保存在 JSON 中，可后续恢复

### 查看哪些产品需要补货

- 补货数量有具体数值时，整行黄色高亮
- 补货筛选提供 6 个选项：全部 / 需要补货 / 需补货未下单 / 不需要补货 / 已下单 / 本地仓有货
- `补货用时`、`本地仓库`、`已下单` 可直接改，补货数量按 `FBA总量` 自动重算

### 查看风险产品

以下情况会整格标红：

- 广告费率 > 15
- 退款率 > 10
- 退货率 > 10
- 毛利润 < 0
- ROI < 0

## 技术栈

- Vite 6
- Vue 3（`<script setup>` 单文件组件）
- Element Plus + `@element-plus/icons-vue`，通过 `unplugin-auto-import` 和 `unplugin-vue-components` 按需引入
- SheetJS (`xlsx`) 解析 xlsx / csv
- PDFKit 生成本地仓库 PDF
- 本地 JSON 文件存储
- 自定义 Vite 中间件 API
- Vitest + `@vue/test-utils` + jsdom

## 环境要求

- Node.js 18+
- npm

其他命令：

```bash
npm run build
npm test
npm run test:coverage
npm run cleanup:dup-asin
```

`npm run preview` 仅预览前端构建产物，不包含本项目的本地文件 API；需要导入、编辑或导出数据时，请使用 `npm run dev`。

`npm run cleanup:dup-asin` 用于合并跨店铺重复的 ASIN 记录，脚本在 `scripts/cleanup-duplicate-asins.mjs`。

每次导入周数据或删除周快照前，应用会自动将 `src/data/` 备份到 `.opa-backups/`，并仅保留最近 10 份。恢复时请先停止开发服务器，再用对应备份目录中的 `data/` 替换 `src/data/`。备份与测试覆盖率报告均不会提交到 Git。

开发模式下每次重启 dev server 都会生成新的会话 ID，前端发现 ID 变化时会清空所有 `opa:` 开头的 localStorage，避免旧列配置和旧筛选残留。

## 测试与构建

```bash
# 全部单元、集成和界面测试
npm test

# 生成 src/lib 业务规则的覆盖率报告
npm run test:coverage

# 仅运行本地 API 集成测试
npm run test:api

# 仅运行导入弹窗界面测试
npm run test:ui

# 构建前端生产产物
npm run build
```

覆盖率只统计 `src/lib/` 下的业务规则模块，`App.vue` 和 `vite.config.js` 不在统计范围内。阈值为行 90%、函数 90%、语句 90%、分支 85%，低于阈值会失败。仓库中的 CI 会在推送和 Pull Request 时运行测试、覆盖率检查与生产构建。

## 数据结构

```text
src/data/
  shops.json                店铺列表
  weeks.json                周快照索引
  restockConfig.js          补货计算参数
  products/
    shop-1.json             店铺 1 的 ASIN 主数据
    shop-2.json             店铺 2 的 ASIN 主数据
    shop-3.json             店铺 3 的 ASIN 主数据
  weeks/
    {weekId}.json           单周快照
```

### shops.json

保存店铺主数据，例如：

```json
[
  {
    "id": "shop-1",
    "name": "CZH-主店一号",
    "mdExportName": "一号店",
    "country": "美国",
    "note": ""
  }
]
```

`name` 需与周报“店铺”列的值一致，用来把每行数据归到店铺；`mdExportName` 只用于 PDF 导出时的标题和文件名。

### weeks.json

周快照索引，按周记录来源文件和导入时间：

```json
[
  {
    "id": "36周",
    "filename": "36周(08-30~09-05)/订单利润-ASIN-2026-08-30~2026-09-05-955119418385620992.xlsx",
    "startDate": "2026-08-30",
    "endDate": "2026-09-05",
    "rowCount": 213,
    "listingFiles": ["Listing销售库存_2026-08-07_2026-09-05.csv"],
    "importedAt": "2026-09-06T07:04:58.252Z"
  }
]
```

### products/shop-x.json

每个店铺一个文件，保存该店铺下的 ASIN 主数据。字段按来源分三类。

**手工维护，导入时不会被覆盖：**

| 字段 | 说明 |
|------|------|
| `name` | 品名 |
| `category` | 产品分类 |
| `restockCycle` | 补货用时，默认 2 |
| `localWarehouse` | 本地仓库数量 |
| `orderedQty` | 已下单数量 |
| `packingMode` | 装箱方式，`full` 整箱 / `mixed` 混装 |

**导入 Listing 表时刷新：**

| 字段 | 说明 |
|------|------|
| `fnsku` | FNSKU |
| `productTitle` | 商品标题 |
| `fbaTotal` `sellable` `inbound` `unsellable` `reserved` | FBA 库存明细 |
| `monthSales` `monthRevenue` `monthOrders` `dailySales` `vineGiftSales` | 月度销售指标 |
| `packageSize` `packageType` `packageCost1` `packageCost2` | 包装信息 |
| `outerCartonSize1` `outerCartonSize2` `maxCartonQty1` `maxCartonQty2` | 外箱信息 |
| `itemWeight` | 单品重量，单位克 |
| `amazonMainImage` `productImage` `productImages` `listingDetailImages` | 图片 URL |

**系统维护：**

| 字段 | 说明 |
|------|------|
| `asin` `parentAsin` | ASIN 与父 ASIN |
| `firstSeenWeek` `lastSeenWeek` | 首次和最近出现的周次 |

`packageSize1` `packageSize2` `packageType1` `packageType2` `stock` 是历史遗留字段，读取时作为 `packageSize` `packageType` `fbaTotal` 的兜底来源，新导入不再写入。

示例：

```json
[
  {
    "asin": "B0CYCGY6NM",
    "parentAsin": "B0D4232M1H",
    "name": "战术笔记本A5",
    "category": "正常",
    "restockCycle": 2,
    "fbaTotal": 204,
    "sellable": 8,
    "inbound": 195,
    "localWarehouse": 0,
    "orderedQty": 0,
    "packageSize": "30×25×1",
    "packageType": "磨砂袋",
    "itemWeight": 600,
    "packingMode": "mixed",
    "firstSeenWeek": "31周",
    "lastSeenWeek": "36周"
  }
]
```

### weeks/{weekId}.json

保存单周快照：

- `id`: 周次 ID
- `filename`: 订单利润源文件相对路径
- `listingFiles`: 该周使用的 Listing 文件名列表
- `columns`: 订单利润表原始表头
- `rows`: 原始行数据，形如 `{ asin, values }`，`values` 与 `columns` 一一对应
- `notes`: 该周的 ASIN 备注，形如 `{ "B0XXXX": "备注内容" }`

这部分用于保留每周指标，不会因为后续编辑主数据而丢失历史值。

## 导入规则

导入时系统会自动：

- 备份 `src/data/` 到 `.opa-backups/`
- 写入 `src/data/weeks/{weekId}.json`
- 更新 `src/data/weeks.json`
- 发现新店铺时自动追加到 `shops.json`
- 发现新 ASIN 时，按店铺写入对应的 `products/shop-x.json`
- 用 Listing 表刷新库存、包装、图片等字段

已存在的 ASIN：

- 不覆盖已维护的品名、分类、补货用时、本地仓库、已下单、装箱方式
- 更新 `lastSeenWeek` 和 Listing 来源字段

只在 Listing 表里出现、订单利润表里没有的 ASIN，无法自动判断店铺归属，会进入导入后的归属确认面板，由你选择店铺后再写入。

## 页面规则

### 字段与规则速查

| 字段 | 来源 | 是否可编辑 | 规则 / 说明 |
|------|------|------------|-------------|
| 亚马逊主图 | `products/shop-x.json` | 否 | 点击可放大预览，支持多图切换 |
| 品名 | `products/shop-x.json` | 是 | 直接在表格中修改，实时写回 JSON |
| ASIN | 快照 + products 主键 | 否 | 点击可复制，也可跳转亚马逊商品页 |
| 产品分类 | `products/shop-x.json` | 是 | 可选：正常 / 新品 / 观望 / 断货 / 放弃 |
| 周销量 | 周快照 | 否 | 快照里的列名是“销量”，界面显示为“周销量” |
| 月销量 / 月销售额 / 月订单数 / 日均销量 / Vine赠品销量 | `products/shop-x.json` | 否 | 来自 Listing 表 |
| 采购成本 | 周快照 | 否 | 原始通常为负数，展示时转为正数 |
| 毛利润 | 周快照 | 否 | 小于 0 整格标红 |
| 广告费率 | 周快照 | 否 | 大于 15 整格标红 |
| 退款率 | 周快照 | 否 | 大于 10 整格标红 |
| 退货率 | 周快照 | 否 | 大于 10 整格标红 |
| ROI | 公式 | 否 | `ROUND(毛利润 / 采购成本, 2)`，小于 0 整格标红 |
| FBA总量 / 可售 / 入库中 / 不可售 / 预留 | `products/shop-x.json` | 否 | 来自 Listing 表 |
| 本地仓库 | `products/shop-x.json` | 是 | 影响补货筛选和 PDF 导出 |
| 已下单 | `products/shop-x.json` | 是 | 影响补货筛选 |
| 补货用时 | `products/shop-x.json` | 是 | 默认 2，影响补货数量计算 |
| 补货数量 | 公式 | 否 | 有具体数值时整行高亮 |
| 备注 | `weeks/{weekId}.json` | 是 | 按周保存，切换周次互不影响 |

### 固定列

- 亚马逊主图
- 品名
- ASIN

### 默认展示列顺序

- 产品分类
- 周销量
- 月销量
- 月销售额
- 月订单数
- 日均销量
- Vine赠品销量
- 采购成本
- 毛利润
- 广告费率
- ROI
- 退货率
- 退款率
- 备注

其余列默认隐藏，但可在“字段设置”面板中自行控制。无论怎么排序，月度指标始终跟在周销量后面，退货率和退款率跟在 ROI 后面，备注固定在最后一列。

### 筛选

工具栏提供 5 个筛选条件，可叠加使用，右侧“重置”按钮一次清空：

| 筛选 | 选项 |
|------|------|
| 店铺 | 全部 / 各店铺名 |
| 补货 | 全部 / 需要补货 / 需补货未下单 / 不需要补货 / 已下单 / 本地仓有货 |
| 分类 | 全部 / 正常 / 新品 / 观望 / 断货 / 放弃 |
| 库存健康 | 全部 / 健康 / 不足 |
| ASIN / FNSKU | 关键词搜索，两个字段任一命中即可 |

“需补货未下单”指需要补货、本地仓库为 0 且已下单为 0 的产品，是最需要立刻处理的一档。

### 计算规则

#### ROI

```text
ROUND(毛利润 / 采购成本, 2)
```

说明：

- 快照中采购成本通常为负数，计算和展示时都取绝对值
- ROI 的正负由毛利润决定
- 采购成本为 0 或缺失时返回空

#### 补货数量

```text
IF(FBA总量 < 周销量 * (restockMonths + 补货用时), 周销量 * restockMultiplier * quantityDiscount, "无需补货")
```

参数在 `src/data/restockConfig.js` 中配置，当前值为 `restockMonths: 8`、`restockMultiplier: 8`、`quantityDiscount: 1`。

说明：

- 这里的“周销量”直接取周报中的 7 天销量
- 库存不足两个月（8 周）加补货周期时，补充两个月（8 周）销量
- 周销量为 0 时直接返回“无需补货”
- FBA总量、周销量、补货用时任一缺失时返回空
- 若计算结果需要补货，则整行高亮

#### 库存健康

```text
(可售 + 预留) > 月销量 * 1.5 ? "健康" : "不足"
```

#### 重量类型

```text
体积重(g) = 长 * 宽 * 高 / 6000 * 1000
单品重量 > 体积重 ? "实重" : "抛重"
```

包装尺寸解析不出三个维度，或单品重量缺失时显示 `—`。

### 产品分类

支持五种状态：

- 正常
- 新品
- 观望
- 断货
- 放弃

规则：

- 父体改为“放弃”时，同店铺下的所有子体自动改为“放弃”
- “放弃”的产品不会在主表格中展示，但仍保留在 JSON 中

### 排序规则

- 含整箱产品的父组排在前面，其余按毛利润从高到低
- 组内先按毛利润从高到低，再把整箱产品提到前面

## 高亮规则

### 红色整格

- 广告费率 > 15
- 退款率 > 10
- 退货率 > 10
- 毛利润 < 0
- ROI < 0

### 黄色提示

- 补货数量有具体数值时，整行高亮

## 本地存储

浏览器 `localStorage` 会保存：

| Key | 内容 |
|-----|------|
| `opa:current-week:v1` | 当前周次 |
| `opa:shop-filter:v1` | 店铺筛选 |
| `opa:supply-filter:v1` | 补货筛选 |
| `opa:column-config:v4` | 自定义列配置（显隐与顺序） |
| `opa:dev-session:v1` | dev server 会话 ID，用于重启后清缓存 |

分类筛选、库存健康筛选和 ASIN 搜索不持久化，刷新后回到“全部”。

## 问题排查

### 为什么没看到待导入文件

常见原因：

- 文件不在 `public/data/周次目录/` 下
- 订单利润文件名不含“订单利润”，或后缀不是 `.xlsx`
- Listing 文件名不以 `Listing销售库存` 开头
- 文件名以 `~$` 开头（Excel 临时文件会被自动忽略）
- 该文件已经导入过（会显示在“已导入”，不会出现在“待导入”）

建议按下面顺序检查：

1. 确认文件路径是 `public/data/xxx周xxx/订单利润xxx.xlsx`
2. 回到页面点击“扫描并导入”重新扫描
3. 在导入抽屉里看“已导入”列表里是否已存在同名周次
4. 如果想重导，先删除该周快照，再重新扫描导入

### 为什么启动后没自动导入

这是当前设计，不是故障：

- 启动时只加载已有 JSON（店铺、产品、周索引）
- 不会自动扫描并导入表格
- 必须手动点击“扫描并导入”再执行导入

这样可以避免每次启动都改动本地数据文件。

### 为什么放弃产品看不到了

这是当前规则：

- 产品分类为“放弃”后，不在主表格展示
- 如果父 ASIN 标记为“放弃”，同店铺的子 ASIN 也会联动“放弃”并隐藏

如果要恢复展示：

1. 打开“ASIN”管理抽屉
2. 搜索该 ASIN
3. 把分类从“放弃”改回“正常 / 观望 / 断货”

如果在主表里找不到它，这是正常现象，需要在 ASIN 抽屉中恢复。

### 为什么导出 PDF 按钮点不动

按钮需要同时满足两个条件：选中单个店铺，并且补货筛选切换到“本地仓有货”。鼠标移到按钮上会提示当前缺哪个条件。筛选结果为空时同样无法导出。

### 为什么导出的 PDF 里中文变成方块

PDF 生成依赖系统中文字体，当前只在 macOS 常见路径中查找（Arial Unicode、STHeiti、PingFang）。在没有这些字体的系统上，中文会退化为默认字体。

### 为什么导出的 PDF 里缺图片

图片是服务端现拉取的，以下情况会跳过：

- 不是 https 链接
- 指向 localhost 或内网地址
- 单张超过 5 MB
- 拉取超时或失败

每行最多渲染 12 张图片。

## API 概览

项目通过 `vite.config.js` 中的本地中间件提供接口，所有路径都挂在 `/api` 下：

| 方法与路径 | 用途 |
|------------|------|
| `GET /api/dev-session` | 返回 dev server 会话 ID |
| `GET /api/shops` | 店铺列表 |
| `POST /api/shops` | 新增店铺 |
| `PUT /api/shops/:id` | 修改店铺 |
| `DELETE /api/shops/:id` | 删除店铺 |
| `GET /api/products` | 全部店铺的 ASIN 主数据 |
| `POST /api/products` | 新增 ASIN |
| `PUT /api/products/:asin` | 修改 ASIN |
| `DELETE /api/products/:asin` | 删除 ASIN |
| `GET /api/weeks` | 周快照索引 |
| `GET /api/weeks/:id` | 单周快照 |
| `DELETE /api/weeks/:id` | 删除单周快照 |
| `PUT /api/weeks/:weekId/notes/:asin` | 保存该周某个 ASIN 的备注 |
| `GET /api/restock-config` | 补货计算参数 |
| `GET /api/scan` | 扫描待导入和已导入周次 |
| `GET /api/scan-signature` | 数据目录指纹，用于判断是否需要重扫 |
| `POST /api/import` | 导入一个或多个周次 |
| `POST /api/import/resolve-listing-only` | 为仅 Listing 表出现的 ASIN 指定店铺归属 |
| `POST /api/export/local-warehouse-pdf` | 生成本地仓库 PDF |

## 开发说明

- 前端主界面在 `src/App.vue`
- 导入弹窗在 `src/components/ImportDialog.vue`
- 样式在 `src/style.css`
- 导入、JSON 读写、PDF 生成、API 中间件都在 `vite.config.js`
- 可测试的业务规则抽在 `src/lib/` 下：
  - `restockRules.js` 补货数量公式
  - `productUpdates.js` 分类联动与整箱优先排序
  - `dataPipeline.js` 表格解析、字段归一化、文件名识别
  - `importScan.js` 扫描结果过滤

新增业务规则时优先放进 `src/lib/`，这样才会被覆盖率统计和单元测试覆盖。

## 备注

这是一个本地使用工具，数据直接写入仓库内的 JSON 文件。

本地 API 仅监听 `127.0.0.1`。店铺 ID、周次 ID、导入文件尺寸与工作表规模都会在服务端校验；PDF 导出仅下载受限制的 HTTPS 图片资源。

如果要迁移到多人协作或线上部署，需要额外补：

- 数据库
- 用户权限
- 文件上传接口
- 并发写入保护
