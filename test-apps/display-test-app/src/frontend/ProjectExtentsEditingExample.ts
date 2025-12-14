/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/

import { Id64String } from "@itwin/core-bentley";
import { QueryBinder, QueryRowFormat } from "@itwin/core-common";
import { BriefcaseConnection, IModelApp, Viewport } from "@itwin/core-frontend";
import { Range3d, Transform, Vector3d } from "@itwin/core-geometry";
import { createButton } from "@itwin/frontend-devtools";
import { transformElements } from "./EditingTools";
import { ToolBarDropDown } from "./ToolBar";

const defaultOffset = Vector3d.create(50_000, 0, 0);
const instructionText = [
  "1. Use the editing scope button to enter editing mode. Moving the sample elements below their project extents keeps their tiles visible while the scope is active.",
  "2. Save the briefcase locally so tile ranges are recomputed. The model is now outside the extents and tiles are no longer requested.",
  "3. Move the same elements back inside the extents without saving. Use the request button to ask for new tiles even though the saved location is still out of range.",
];

async function getSampleElementIds(imodel: BriefcaseConnection, modelId: Id64String): Promise<string[]> {
  const elementIds: string[] = [];
  const reader = imodel.createQueryReader(
    "SELECT ECInstanceId FROM bis.GeometricElement3d WHERE Model.Id=? LIMIT 50",
    QueryBinder.from([modelId]),
    { rowFormat: QueryRowFormat.UseJsPropertyNames },
  );

  for await (const row of reader) {
    if ("string" === typeof row.id)
      elementIds.push(row.id);
  }

  return elementIds;
}

function getRangeBasedOffset(extents: Range3d): Vector3d {
  const length = Math.max(extents.xLength(), extents.yLength(), extents.zLength());
  if (length <= 0)
    return defaultOffset.clone();

  const scale = Math.max(length * 2, defaultOffset.magnitude());
  return Vector3d.create(scale, 0, 0);
}

export class ProjectExtentsEditingExample extends ToolBarDropDown {
  private readonly _element: HTMLElement;
  private readonly _modelSelect: HTMLSelectElement;
  private readonly _status: HTMLDivElement;
  private _lastOffset?: Vector3d;

  public constructor(parent: HTMLElement, private readonly _vp: Viewport) {
    super();
    this._element = document.createElement("div");
    this._element.className = "toolMenu";
    this._element.style.display = "block";

    const title = document.createElement("div");
    title.innerText = "Project Extents and Editing Scope";
    title.style.fontWeight = "bold";
    title.style.marginBottom = "6px";
    this._element.appendChild(title);

    for (const paragraph of instructionText) {
      const p = document.createElement("div");
      p.innerText = paragraph;
      p.style.marginBottom = "4px";
      this._element.appendChild(p);
    }

    this._modelSelect = document.createElement("select");
    this._modelSelect.style.width = "100%";
    this._modelSelect.style.margin = "6px 0";
    this.populateModels();
    this._element.appendChild(this._modelSelect);

    const editingButton = createButton({
      parent: this._element,
      value: "Enter or exit editing scope",
      handler: async () => this.toggleEditingScope(),
    });
    editingButton.style.marginBottom = "4px";

    const moveOutside = createButton({
      parent: this._element,
      value: "Move sample outside extents (no save)",
      handler: async () => this.moveSample(true),
    });
    moveOutside.style.marginBottom = "4px";

    const saveButton = createButton({
      parent: this._element,
      value: "Save and refresh tiles",
      handler: async () => this.saveAndRefresh(),
    });
    saveButton.style.marginBottom = "4px";

    const moveBack = createButton({
      parent: this._element,
      value: "Move sample back inside (no save)",
      handler: async () => this.moveSample(false),
    });
    moveBack.style.marginBottom = "4px";

    const requestTiles = createButton({
      parent: this._element,
      value: "Request tiles without saving",
      handler: async () => this.requestTiles(),
    });
    requestTiles.style.marginBottom = "4px";

    this._status = document.createElement("div");
    this._status.style.marginTop = "6px";
    this.setStatus("Select a model to exercise tile requests against project extents.");
    this._element.appendChild(this._status);

    parent.appendChild(this._element);
  }

  public get isOpen(): boolean { return "none" !== this._element.style.display; }
  protected _open(): void { this._element.style.display = "block"; }
  protected _close(): void { this._element.style.display = "none"; }

  public override async onViewChanged(): Promise<void> {
    this.populateModels();
  }

  private setStatus(message: string): void {
    this._status.innerText = message;
  }

  private getBriefcase(): BriefcaseConnection | undefined {
    const imodel = this._vp.iModel;
    return imodel.isBriefcaseConnection() ? imodel : undefined;
  }

  private get selectedModelId(): Id64String | undefined {
    return this._modelSelect.value || undefined;
  }

  private populateModels(): void {
    const current = this._modelSelect.value;
    this._modelSelect.innerHTML = "";

    this._vp.view.forEachModel((model) => {
      const option = document.createElement("option");
      option.value = model.id;
      option.text = model.name ?? model.id;
      this._modelSelect.appendChild(option);
    });

    if (current)
      this._modelSelect.value = current;
  }

  private async toggleEditingScope(): Promise<void> {
    const imodel = this.getBriefcase();
    if (!imodel) {
      this.setStatus("Editing scope requires a writable briefcase.");
      return;
    }

    if (imodel.editingScope)
      await imodel.editingScope.exit();
    else
      await imodel.enterEditingScope();

    this.setStatus(imodel.editingScope ? "Editing scope is active." : "Editing scope ended.");
  }

  private getOffset(imodel: BriefcaseConnection): Vector3d {
    return getRangeBasedOffset(imodel.projectExtents);
  }

  private async moveSample(outside: boolean): Promise<void> {
    const imodel = this.getBriefcase();
    const modelId = this.selectedModelId;
    if (!imodel || !modelId) {
      this.setStatus("Select a model and ensure the iModel is writable.");
      return;
    }

    if (!imodel.editingScope) {
      await imodel.enterEditingScope();
    }

    const ids = await getSampleElementIds(imodel, modelId);
    if (0 === ids.length) {
      this.setStatus("No geometric elements were found in the selected model.");
      return;
    }

    const offset = this._lastOffset ?? this.getOffset(imodel);
    const translation = outside ? offset : offset.negate();
    this._lastOffset = offset;

    await transformElements(imodel, ids, Transform.createTranslation(translation));

    if (outside)
      this.setStatus("Moved sample geometry beyond the project extents while editing.");
    else
      this.setStatus("Moved sample geometry back within the project extents without saving.");
  }

  private async saveAndRefresh(): Promise<void> {
    const imodel = this.getBriefcase();
    const modelId = this.selectedModelId;
    if (!imodel || !modelId) {
      this.setStatus("Select a model and ensure the iModel is writable.");
      return;
    }

    await imodel.saveChanges("Project extents tile example");
    IModelApp.viewManager.refreshForModifiedModels([modelId]);
    this.setStatus("Saved the briefcase and refreshed tiles. Geometry outside project extents will stop requesting tiles.");
  }

  private async requestTiles(): Promise<void> {
    const modelId = this.selectedModelId;
    if (!modelId) {
      this.setStatus("Select a model before requesting tiles.");
      return;
    }

    IModelApp.viewManager.refreshForModifiedModels([modelId]);
    this.setStatus("Requested tiles for the modified model without saving.");
  }
}
