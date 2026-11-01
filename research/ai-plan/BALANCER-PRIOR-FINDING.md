# 决定性发现：模型对 balancer 的先验知识是错的

> 2026-11-02。这条发现直接改变了对「经验形态 A/B」的理解。
> 证据来源：第二轮 A/B 的原始 `thinking` 文本（`.tmpverify/ab-capacity/results-v2.json`）。

---

## 事实

**48/48 条 thinking（A2 24 条 + B2 24 条）在推理过程中都假设了「balancer 会分流」。**

而源码证明这是**假的**。

### 源码真相

```js
// recon/upstream-full/src/js/game/buildings/balancer.js:179-200
// default 变体（2×1）：2 个输入（底部），2 个输出（顶部）
entity.components.ItemEjector.setSlots([
    { pos: new Vector(0, 0), direction: enumDirection.top },
    { pos: new Vector(1, 0), direction: enumDirection.top },
]);
```

```js
// recon/upstream-full/src/js/game/systems/item_processor.js:146-157
} else {
    // We can eject on any slot
    slot = ejectorComp.getFirstFreeSlot();
}
```

```js
// recon/upstream-full/src/js/game/components/item_ejector.js:117-125
getFirstFreeSlot() {
    for (let i = 0; i < this.slots.length; ++i) {
        if (this.canEjectOnSlot(i)) return i;
    }
    return null;
}
```

⇒ **不轮转、不随机、不均分。** 永远是第一个空槽。左边堵了才走右边。

### 模型的原话（rep 1）

> "a balancer splits output between primary and secondary; if secondary is
> unconnected, **half the items go nowhere**? Actually balancer with secondary
> unconnected might drop items or just output only primary? **Likely it splits
> 50/50, and the unconnected secondary output wastes half.** That would explain
> produced RuRuRuRu 108 but the cutter only sees..."

它**自己也不确定**（"might"、"Likely"），但**猜错了方向**，然后基于这个猜测去行动。

---

## 这条发现改变了什么

### 1. 它解释了 A2 臂 14/26「误判」的成因

不是模型「不够聪明」，是它**带着一个错误的先验**。

A2 臂里 15/26 次的动作是「给 balancer 的 secondary 输出接垃圾桶」。
模型的理由：**「另一半在浪费，接垃圾桶让它别堵」**。

而在真实机制下：
- secondary 本来就不走货（左边没堵的时候）
- 接垃圾桶 = 给了一个「永远有空槽」的出口
- 一旦左边堵住，**全部货冲进垃圾桶**

⇒ **模型的动作在错误前提下是对的，在正确机制下是有害的。**

### 2. 它说明「手写心得」形态有一个**非平凡**的用例

之前我认为 (b) 手写心得的价值在于「教模型游戏技巧」。
现在看更准确的说法是：

> **手写心得的价值在于纠正模型的错误先验，而不是补充它没有的知识。**

「balancer 先填满左边，左边堵了才走右边」这一条，
不是「技巧」，是**对错误常识的更正**。

而这类知识点可以用**极短的文本**表达（一句话），
不需要长篇大论 —— 这与 `QUALITY-METRICS.md` 里「prompt 变长会挤掉带子表」的
警告正好相容。

### 3. 它是「静态经验 vs 动态观察面」这个问题的**第三种答案**

红队 agent 在攻击「经验 vs 观察面是不是一回事」。
这条发现给出了第三种可能：

| 类型 | 例子 | 机制 |
|---|---|---|
| **动态观察面** | CAPACITY 段（supply 1.8 / processing 0.5 / 瓶颈 cutter） | 告诉模型**现在是什么状态** |
| **静态经验（技巧）** | 「长竖直段要留转弯空间」 | 告诉模型**一般该怎么做** |
| **静态经验（纠错）** | 「balancer 不是均分，是填满左边再走右边」 | **纠正模型已有的错误信念** |

**第三类的效应量可能远大于第二类** —— 因为它的作用不是「增加信息」，
而是「移除一个持续产生错误决策的污染源」。

而第三类有个独特优势：**可以用 A/B 干净地测**。
因为错误先验是模型自带的，不是 prompt 给的，所以：
- 控制臂：不给这条更正 → 模型按错误先验行动
- 实验臂：给这条更正 → 看它是否改

---

## 必须在 C 实验里做的检验

### 检验 1：给正确的 balancer 语义，A2 臂的「误判」会不会消失？

如果会 ⇒ 那条「误判 14/26」根本不是模型的能力问题，是知识问题。
整个「模型不会玩」的判断要修正。

### 检验 2：(b) 形态里放「纠错型」vs「技巧型」经验，效应量差多少？

如果纠错型显著更大 ⇒ 经验库的设计原则应该是
**「先找模型错在哪，再写更正」，而不是「先攒技巧」**。

这直接决定 (a) 案例库该攒什么：(c) 自复盘该复盘什么。

---

## 诚实边界

1. **48/48 是 thinking 文本的正则匹配**。模型可能只是在「考虑这个可能性」而不是「相信它」。
   但 rep 1 的原话（"Likely it splits 50/50"）表明它确实倾向相信。
   要更严格，需要看 `calls` 是否**基于这个信念行动** —— 15/26 接了垃圾桶，是的行为证据。

2. **B2 臂也 24/24 有同样的误判**，但 B2 的 `处理瓶颈` 是 16/25。
   说明 CAPACITY 段能把模型**拉回来**一部分，但没有消除错误先验。
   ⇒ 两种信息（动态观察 + 静态纠错）可能是**互补**而非替代。

3. **只在一个场景上观察到**。别的场景（stacker / painter / tunnel）有没有类似的
   「模型自带错误先验」，没测过。

---

## 复现

```bash
cd "D:/Projects/rea/Project work/shapez"
node -e "
const r=require('./.tmpverify/ab-capacity/results-v2.json');
const rows=r.filter(x=>(x.thinking||'').length>100);
const re=/balancer[^.]{0,200}?(split|half|50\/50|waste)/i;
for(const arm of ['A2','B2']){
  const sub=rows.filter(x=>x.arm===arm);
  console.log(arm, sub.filter(x=>re.test(x.thinking)).length, '/', sub.length);
}
"
```
