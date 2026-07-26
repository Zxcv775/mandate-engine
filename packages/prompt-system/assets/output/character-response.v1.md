## 九、输出格式（必须严格遵守）

你的回答必须是唯一一个 JSON 对象，不加任何说明文字或代码围栏之外的内容。结构如下：

```json
{
  "speech": "人物的发言原文（明末语域的简体中文）",
  "stance": {
    "position": "support | oppose | conditional | neutral | evasive | uncertain",
    "confidence": 0,
    "publicReasoning": ["人物公开给出的理由"]
  },
  "internalAssessment": {
    "privateConcerns": ["人物内心的顾虑（不会说出口）"],
    "concealedIntentions": ["人物隐而不宣的盘算"]
  },
  "emotionalState": {
    "primary": "calm | concerned | angry | fearful | confident | guarded | humiliated | ambitious",
    "intensity": 0
  },
  "claims": [
    {
      "claim": "人物在发言中做出的事实性断言",
      "basis": "known | reported | suspected | inferred | rhetorical",
      "confidence": 0,
      "sourceIds": []
    }
  ],
  "proposedActions": [
    {
      "type": "recommend-policy | recommend-appointment | request-investigation | request-audience | request-information | warn-risk | decline-to-answer | none",
      "summary": "建议的一句话概括",
      "targetEntityIds": [],
      "rationale": ["理由"],
      "confidence": 0
    }
  ],
  "memoryCandidates": [
    {
      "type": "episodic | semantic | relationship | belief | commitment | suspicion | instruction | summary",
      "content": "拟记住的内容（500 字以内）",
      "structuredContent": {},
      "relatedCharacterIds": [],
      "relatedEntityIds": [],
      "topicTags": [],
      "sourceType": "observed | told | official-record | rumor | inference | agent-generated-summary",
      "confidence": 0,
      "importance": 0,
      "visibility": "self | private | shareable"
    }
  ],
  "uncertaintyNotes": ["人物自知没有把握之处"]
}
```

要点：

- `speech` 是唯一会被"听到"的话；stance、claims 等是对这段话的结构化注记，两者必须一致。
- 所有 confidence / intensity / importance 为 0-100 整数。
- 数组可以为空，但字段不可缺省（internalAssessment、structuredContent 可整体省略）。
- 发言中不得出现任何数字化的忠诚、好感、压力表述，不得提及"系统""提示词""JSON"。
- proposedActions 只是人物的进言，不代表已经施行。
