/*
 * DSA Studio — takeuforward.org progress exporter.
 *
 * Open the Striver A2Z sheet on takeuforward.org while signed in, open your
 * browser console (F12 → Console), paste this whole script and press Enter.
 * It walks every step and subsection, reads the Completed and Revision
 * checkboxes, and downloads "striver_a2z_complete_sheet.csv".
 *
 * Then upload that CSV on the Import page.
 */
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const csvEscape = (value) => {
    const str = String(value ?? "")
      .replace(/\r?\n|\r/g, " ")
      .trim();

    return `"${str.replace(/"/g, '""')}"`;
  };

  const absoluteUrl = (href) => {
    if (!href) return "";

    try {
      return new URL(href, location.origin).href;
    } catch {
      return href;
    }
  };

  const waitFor = async (condition, timeout = 5000, interval = 100) => {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const result = condition();

      if (result) return result;

      await sleep(interval);
    }

    return null;
  };

  const getDirectTrigger = (accordionItem) => {
    return accordionItem.querySelector(
      ':scope > h3 > button[data-slot="accordion-trigger"]'
    );
  };

  const getDirectContent = (accordionItem) => {
    return accordionItem.querySelector(
      ':scope > div[data-slot="accordion-content"]'
    );
  };

  const results = new Map();

  const accordionItems = [
    ...document.querySelectorAll(
      'div[data-slot="accordion-item"].tuf-accordion-row'
    )
  ];

  console.log(`Found ${accordionItems.length} top-level accordion items.`);

  for (let stepIndex = 0; stepIndex < accordionItems.length; stepIndex++) {
    const accordionItem = accordionItems[stepIndex];

    const trigger = getDirectTrigger(accordionItem);
    const content = getDirectContent(accordionItem);

    if (!trigger || !content) {
      console.warn(`Skipping accordion ${stepIndex + 1}: invalid structure`);
      continue;
    }

    const stepName =
      trigger.querySelector(".tuf-accordion-title")?.textContent?.trim() ||
      `Step ${stepIndex + 1}`;

    console.log(
      `[${stepIndex + 1}/${accordionItems.length}] Processing: ${stepName}`
    );

    /*
     * Open top-level accordion if necessary.
     */
    if (trigger.getAttribute("aria-expanded") !== "true") {
      trigger.click();

      await waitFor(
        () =>
          content.getAttribute("data-state") === "open" &&
          content.querySelector(".tuf-subrow"),
        10000
      );

      await sleep(300);
    }

    /*
     * Find subsections belonging only to this accordion.
     */
    const subrows = [...content.querySelectorAll(".tuf-subrow")];

    console.log(`  Found ${subrows.length} subsections`);

    for (
      let subsectionIndex = 0;
      subsectionIndex < subrows.length;
      subsectionIndex++
    ) {
      const subrow = subrows[subsectionIndex];

      const subsectionButton = subrow.querySelector(".tuf-subrow-btn");

      const subsectionName =
        subsectionButton
          ?.querySelector("span.flex-1")
          ?.textContent?.trim() ||
        subsectionButton
          ?.querySelector("span")
          ?.textContent?.trim() ||
        `Subsection ${subsectionIndex + 1}`;

      console.log(`    Processing: ${subsectionName}`);

      /*
       * Open subsection if closed.
       */
      if (
        subsectionButton &&
        subsectionButton.getAttribute("aria-expanded") !== "true"
      ) {
        subsectionButton.click();

        await waitFor(
          () => subrow.querySelector("table tbody tr"),
          5000
        );

        await sleep(100);
      }

      /*
       * Extract rows.
       */
      const rows = [
        ...subrow.querySelectorAll("table tbody tr")
      ];

      console.log(`      ${rows.length} problems`);

      rows.forEach((row) => {
        const cells = row.querySelectorAll("td");

        if (cells.length < 2) return;

        /*
         * Status + Problem ID
         */
        const statusCheckbox = row.querySelector(
          'input.sheet-checkbox[name="complete"]'
        );

        const problemId =
          statusCheckbox?.id ||
          row.querySelector('input[name="complete"]')?.id ||
          "";

        const completed = statusCheckbox?.checked ? "Yes" : "No";

        /*
         * Problem
         */
        const problemAnchor = cells[1]?.querySelector("a");

        const problemName =
          problemAnchor?.textContent?.trim() ||
          cells[1]?.textContent?.trim() ||
          "";

        const problemUrl = absoluteUrl(
          problemAnchor?.getAttribute("href")
        );

        /*
         * Plus Solve
         */
        const plusSolveAnchor = cells[2]?.querySelector("a");

        const plusSolveUrl = absoluteUrl(
          plusSolveAnchor?.getAttribute("href")
        );

        /*
         * Plus Editorial
         */
        const plusEditorialAnchor = cells[3]?.querySelector("a");

        const plusEditorialUrl = absoluteUrl(
          plusEditorialAnchor?.getAttribute("href")
        );

        /*
         * Resources
         */
        let articleUrl = "";
        let youtubeUrl = "";

        const otherResources = [];

        const resourceAnchors = [
          ...(cells[4]?.querySelectorAll("a") || [])
        ];

        resourceAnchors.forEach((anchor) => {
          const href = absoluteUrl(anchor.getAttribute("href"));

          const alt =
            anchor
              .querySelector("img")
              ?.getAttribute("alt")
              ?.toLowerCase() || "";

          if (
            href.includes("youtube.com") ||
            href.includes("youtu.be") ||
            alt.includes("youtube")
          ) {
            youtubeUrl = href;
          } else if (
            alt.includes("postlink") ||
            alt.includes("editorial")
          ) {
            articleUrl = href;
          } else {
            otherResources.push(href);
          }
        });

        /*
         * Practice
         */
        const practiceAnchor = cells[5]?.querySelector("a");

        const practiceUrl = absoluteUrl(
          practiceAnchor?.getAttribute("href")
        );

        /*
         * Revision
         */
        const revisionCheckbox = cells[7]?.querySelector(
          'input[name="revision"]'
        );

        const revision = revisionCheckbox?.checked ? "Yes" : "No";

        /*
         * Difficulty
         */
        const difficulty =
          cells[8]
            ?.querySelector(".difficulty-badge")
            ?.textContent?.trim() ||
          cells[8]?.textContent?.trim() ||
          "";

        /*
         * Deduplicate.
         *
         * Problem ID should normally exist.
         * URL/name fallback protects against missing IDs.
         */
        const uniqueKey =
          problemId ||
          `${stepName}::${subsectionName}::${problemName}::${problemUrl}`;

        results.set(uniqueKey, {
          step: stepName,
          subsection: subsectionName,

          problemId,
          problemName,

          completed,
          revision,
          difficulty,

          problemUrl,

          plusSolveUrl,
          plusEditorialUrl,

          articleUrl,
          youtubeUrl,

          practiceUrl,

          otherResources: otherResources.join(" | ")
        });
      });
    }

    console.log(
      `  Finished ${stepName}. Total collected: ${results.size}`
    );

    /*
     * Close the accordion again.
     *
     * This keeps the page responsive.
     */
    if (trigger.getAttribute("aria-expanded") === "true") {
      trigger.click();
      await sleep(200);
    }
  }

  const data = [...results.values()];

  if (!data.length) {
    console.error("No problems were extracted.");
    return;
  }

  const headers = [
    "Step",
    "Subsection",
    "Problem ID",
    "Problem",
    "Completed",
    "Revision",
    "Difficulty",
    "Problem URL",
    "TUF Plus Solve URL",
    "TUF Plus Editorial URL",
    "Article URL",
    "YouTube URL",
    "Practice URL",
    "Other Resources"
  ];

  const csvRows = [
    headers.map(csvEscape).join(","),

    ...data.map((item) =>
      [
        item.step,
        item.subsection,

        item.problemId,
        item.problemName,

        item.completed,
        item.revision,
        item.difficulty,

        item.problemUrl,

        item.plusSolveUrl,
        item.plusEditorialUrl,

        item.articleUrl,
        item.youtubeUrl,

        item.practiceUrl,

        item.otherResources
      ]
        .map(csvEscape)
        .join(",")
    )
  ];

  const csv = "﻿" + csvRows.join("\n");

  const blob = new Blob([csv], {
    type: "text/csv;charset=utf-8;"
  });

  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");

  link.href = url;
  link.download = "striver_a2z_complete_sheet.csv";

  document.body.appendChild(link);

  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);

  console.table(data);

  console.log("=================================");
  console.log(`Export complete.`);
  console.log(`Problems exported: ${data.length}`);
  console.log("=================================");

  if (data.length < 400) {
    console.warn(
      "Expected roughly 400+ problems. Some accordions may not have rendered correctly."
    );
  }
})();
