/*
 * Plain-language summary of the fill-timing study, for the owner reading as an
 * investor rather than as the analyst. Chart-led; every figure traces to
 * results/results.json and the technical record. Build with:
 *   node build_summary.js
 */
const path = require("path");
const { buildReport } = require("C:/Users/phuaz/.claude/skills/research-review/assets/report_builder.js");

const HERE = __dirname;
const OUT = path.join(HERE, "..", "2026-10-03_fill-timing_adverse-placement_summary.docx");

const spec = {
  meta: {
    title: "Why your trades land near the worst price of the week, and what it costs",
    subtitle: "Plain-language summary of the fill-timing study on the 2026 trades",
    dateISO: "2026-10-03",
    weekday: "Saturday",
    headerLeft: "Fill-timing study: plain-language summary",
    metaLeftW: 2400,
    assetsDir: path.join(HERE, "charts"),
  },
  metaTable: [
    ["The one sentence", "In 2026 your trades were placed, on average, about two-thirds of the way towards the worst price of the week around them, because you tend to act straight after a sharp move; that habit cost about S$34,000 this year, nine times what you paid in commission."],
    ["The question", "You suspected that your fills tend to land at the worst price within three trading days either side. Is that true, and if so, why and how much does it cost?"],
    ["The answer", "True, and larger than you suspected. The cause is which day you trade, not what time of day. A one-day delay would not have helped; changing the moment you decide to act might."],
    ["How it was tested", "Each of the 151 trades with usable price data was scored on where its price sat between the best and worst prices of the seven trading days around it, and compared with a pretend trader who made the same trade on a random nearby day at a random moment. The pass mark was fixed before the result was seen, and an independent review tried to break the design first."],
  ],
  sections: [
    { type: "h1", text: "The findings" },

    { type: "h2", text: "1. You buy and sell close to the worst price of the week" },
    { type: "p", text: "On a worst-price score where 0 is the best price of the seven days around the trade, 1 is the worst and 0.5 is the middle, your trades average 0.64 against 0.50 for the random-day trader; the chance of that gap arising by luck is about one in ten thousand." },
    { type: "chart", file: "fig1_verdict_null_mean_u.png", widthPx: 600,
      caption: "Figure 1. The grey hill is the range of average scores the random-day trader gets over ten thousand tries (the chart calls the score u and the random-day trader the placebo). The red line is the pass mark fixed in advance. The navy line is you." },

    { type: "h2", text: "2. One trade in eight landed almost exactly at the worst price of its week" },
    { type: "p", text: "Eighteen of the 151 trades sat within a tenth of the worst price, where chance would give about six, and 34 were worse than every one of the six closing prices around them, where chance would give about fourteen." },
    { type: "chart", file: "fig2_u_by_fill.png", widthPx: 600,
      caption: "Figure 2. Every trade is one dot, buys on the top row and sells on the bottom, placed by its worst-price score. The grey bands show where the random-day trader's dots would fall; the dotted red line marks the worst tenth." },

    { type: "h2", text: "3. The problem is the day you trade, not the time of day" },
    { type: "p", text: "In the three days before a trade the price had already moved about 5 per cent against you (you bought after a 6.5 per cent rise and sold after a 3.5 per cent fall, on four trades in five), and scoring the trade at that day's closing price gives the same result, so the time of day adds nothing." },
    { type: "chart", file: "fig3_pre_post_legs.png", widthPx: 600,
      caption: "Figure 3. The price move in the three days before the trade (the chart's pre leg) and the three days after (post leg), shown as moves against you. Navy is your trades, grey the random-day trader. The big bars are before the trade: that is the chase." },

    { type: "h2", text: "4. After you buy, the price tends to give a little back; after you sell, it does not bounce" },
    { type: "p", text: "In the three days after a buy the price fell 1.2 per cent on average while the random-day trader saw a 1.2 per cent rise, a 2.4-point difference; after a sell there was no bounce at all." },

    { type: "h2", text: "5. The cost is real money: about S$34,000 this year" },
    { type: "p", text: "Measured against the price the random-day trader would have got in the same week, your trades cost S$34,027 more on S$1.66 million traded, which is 2.05 per cent of the money traded, 8.7 times the 0.24 per cent you paid in commission, and about a sixth of this year's S$194,578 profit on the dashboard." },
    { type: "chart", file: "fig4_cost_anchor.png", widthPx: 600,
      caption: "Figure 4. The extra cost added up trade by trade through the year, in Singapore dollars. The green band is the range a lucky or unlucky random-day trader would stay inside; the line leaves it after about seventy trades and keeps climbing. The chart's bps are hundredths of a per cent." },

    { type: "h2", text: "6. Your sells were not bad decisions, only badly timed" },
    { type: "p", text: "The shares you sold fell a further 1.4 per cent over the next three months while what you bought with the proceeds rose about 5 per cent, so selling was right; it was the day chosen to sell, after a sharp fall, that cost." },

    { type: "h2", text: "7. Waiting one more day would not have fixed it" },
    { type: "p", text: "Had every trade been done one day later at the closing price, the total would have changed by minus S$436, a coin flip, because a delay only acts on what happens after the trade and the cost had already been paid before it." },

    { type: "h1", text: "What this means, and what you could try" },
    { type: "p", text: "The pattern is chasing: a sharp move draws the trade, and by the time the order goes in most of the move has happened. The study measured that; it did not test any cure, so what follows is a list of things worth testing, not a recommendation." },
    { type: "bullets", items: [
      "A cooling-off rule: do not act on a name that has moved more than a set amount over the last three days; revisit it when it has settled.",
      "A price-limit habit: place the order at a price inside the last few days' range instead of at the market, and accept that some trades will not happen.",
      "A split entry: half now, half after the move has settled, so a chase costs half as much.",
      "Whatever you choose, test it on trades made after you adopt it. The 151 trades here have been used to find the pattern and cannot also be used to prove the cure.",
    ] },
    { type: "callout", text: "The margin of error: with 151 trades, average scores within about 0.04 of each other cannot be told apart; your gap of 0.14 is more than three times that. The S$34,000 is a comparison with a random-day trader in the same week, not money that left your account, and it includes the price of waiting for a move to confirm itself, which you may judge worth paying." },

    { type: "h1", text: "Appendix: the work behind the summary" },
    { type: "p", text: "Thirteen tests were declared before the result was seen; one carried the verdict, one a secondary reading, and the rest checked that the result was not an artefact. No rule, setting or dashboard figure was changed as a result." },
    { type: "table",
      headers: ["Could this have fooled the result?", "What was checked", "Outcome"],
      rows: [
        ["Trades dated one day late, so the price would sit in the wrong day", "Every trade price was checked against the day's actual price range", "152 of 154 sat inside their own day; the two that did not had a bad data feed and were excluded"],
        ["A dividend inside the week making a buy look like the top", "Prices put on one basis; the six affected trades removed as a check", "Score 0.633 without them, against 0.639 with"],
        ["Shares that naturally bounce after a sharp move", "The after-trade move compared with random days that had a similar run-up", "Explains at most part of the small after-trade effect; the chase is untouched"],
        ["Trades made on the same day moving together, flattering the odds", "Trades grouped into 47 clusters and the chance of luck computed on the clusters", "Caught by the independent review before the result; the pass mark was raised"],
        ["Luck from a few big names", "The score recomputed with each name dropped in turn", "Between 0.135 and 0.149 above the random-day trader whichever name is dropped"],
      ],
      widths: [3000, 3000, 3026] },
    { type: "p", text: "Every number here traces to the technical record, reviews/2026-10-03_fill-timing_adverse-placement.docx, and to results/results.json in the study folder; the profit figure comes from the dashboard on 3 October 2026 and is a single reading." },
  ],
  signoff: [
    ["Prepared by", "Claude Code research session (Fable 5.1), under direction of Zhenghao Phua"],
    ["Reviewed and approved by", ""],
    ["Date", ""],
    ["Next step", "Yours: decide whether to test a cooling-off or price-limit rule on future trades"],
  ],
  disclaimer: "Personal research artefact on the owner's own ledger. The cost is a comparison with a simulated random-day trader, not realised profit or loss; nothing here is investment advice.",
};

buildReport(spec, OUT).then((r) => console.log("wrote", r.outPath, r.bytes, "bytes"));
