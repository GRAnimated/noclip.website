
import * as Viewer from '../viewer.js';
import * as Yaz0 from '../Common/Compression/Yaz0.js';
import * as BYML from '../byml.js';
import { DataFetcher } from '../DataFetcher.js';
import * as SARC from '../fres_nx/sarc.js';
import * as BFRES from '../fres_nx/bfres.js';
import { GfxDevice } from '../gfx/platform/GfxPlatform.js';
import { BRTITextureHolder, BasicFRESRenderer, FMDLRenderer, FMDLData, SkyRenderer, latLonToDirection, TextureScopeKey } from './Render.js';
import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { assert, assertExists } from '../util.js';
import { mat4 } from 'gl-matrix';
import { SceneContext } from '../SceneBase.js';
import { computeModelMatrixSRT, MathConstants } from '../MathHelpers.js';
import { GfxRenderCache } from '../gfx/render/GfxRenderCache.js';
import { CameraController } from '../Camera.js';

const pathBase = `SuperMarioOdyssey`;
const addon = `SuperMarioOdysseyMod`;
const ENABLE_MODDED = false;

class ResourceSystem {
    public textureHolder = new BRTITextureHolder();
    public mounts = new Map<string, SARC.SARC>();
    public bfresCache = new Map<string, BFRES.FRES | null>();
    public fmdlDataCache = new Map<string, FMDLData | null>();
    public arcPromiseCache = new Map<string, Promise<SARC.SARC | null>>();
    private renderCache: GfxRenderCache;

    constructor(device: GfxDevice) {
        this.renderCache = new GfxRenderCache(device);
    }

    private loadResource(device: GfxDevice, mountName: string, sarc: SARC.SARC): void {
        assert(!this.mounts.has(mountName));
        this.mounts.set(mountName, sarc);

        for (let i = 0; i < sarc.files.length; i++) {
            if (!sarc.files[i].name.endsWith('.bfres'))
                continue;

            // Sanity check: there should only be one .bfres per archive.
            assert(!this.bfresCache.has(mountName));

            const fres = BFRES.parse(sarc.files[i].buffer);
            this.bfresCache.set(mountName, fres);

            const fileName = mountName.substring(mountName.lastIndexOf('/') + 1);
            this.textureHolder.addFRESTextures(device, fres, fileName);
        }
    }

    private async fetchDataInternal(device: GfxDevice, dataFetcher: DataFetcher, arcPath: string): Promise<SARC.SARC | null> {
        let buffer: ArrayBufferSlice | null = null;
        if (ENABLE_MODDED) {
            try {
            buffer = await dataFetcher.fetchData(`${addon}/${arcPath}.szs`, { allow404: true });
            } catch {
            // ignore
            }
        }
        if (!buffer || buffer.byteLength === 0) {
            buffer = await dataFetcher.fetchData(`${pathBase}/${arcPath}.szs`, { allow404: true });
        }

        if (buffer.byteLength === 0)
            return null;

        const decompressed = await Yaz0.decompress(buffer);
        const sarc = SARC.parse(decompressed);

        this.loadResource(device, arcPath, sarc);
        return sarc;
    }

    public fetchData(device: GfxDevice, dataFetcher: DataFetcher, arcPath: string): Promise<SARC.SARC | null> {
        if (!this.arcPromiseCache.has(arcPath))
            this.arcPromiseCache.set(arcPath, this.fetchDataInternal(device, dataFetcher, arcPath));
        return this.arcPromiseCache.get(arcPath)!;
    }

    public waitForLoad(): Promise<void> {
        return Promise.all(this.arcPromiseCache.values()) as unknown as Promise<void>;
    }

    public findFRES(mountName: string): BFRES.FRES | null {
        if (!this.bfresCache.has(mountName)) {
            console.log(`No FRES for ${mountName}`);
            this.bfresCache.set(mountName, null);
        }

        return this.bfresCache.get(mountName)!;
    }

    public getFMDLData(device: GfxDevice, mountName: string): FMDLData | null {
        if (!this.fmdlDataCache.has(mountName)) {
            const fres = this.findFRES(mountName);
            let fmdlData: FMDLData | null = null;
            if (fres !== null) {
                // TODO(jstpierre): Proper actor implementations...
                if (fres.fmdl.length > 0) {
                    assert(fres.fmdl.length === 1);
                    fmdlData = new FMDLData(this.renderCache, fres.fmdl[0]);
                } else {
                    return null;
                }
            }
            this.fmdlDataCache.set(mountName, fmdlData);
        }

        return this.fmdlDataCache.get(mountName)!;
    }

    public findBuffer(mountName: string, fileName: string): ArrayBufferSlice {
        const sarc = assertExists(this.mounts.get(mountName));
        return sarc.files.find((n) => n.name === fileName)!.buffer;
    }

    public destroy(device: GfxDevice): void {
        this.renderCache.destroy();
        this.textureHolder.destroy(device);
        this.fmdlDataCache.forEach((value) => {
            if (value !== null)
                value.destroy(device);
        });
    }
}

type StageMap = { ObjectList?: StageObject[], ZoneList?: StageObject[], SkyList?: StageObject[] }[];
type Vector = { X: number, Y: number, Z: number };
type StageObject = {
    UnitConfigName: string,
    UnitConfig: UnitConfig,
    Rotate: Vector,
    Scale: Vector,
    Translate: Vector,
};
type UnitConfig = {
    DisplayName: string,
    DisplayRotate: Vector,
    DisplayScale: Vector,
    DisplayTranslate: Vector,
    GenerateCategory: string,
    ParameterConfigName: string,
    PlacementTargetFile: string,
};
type GraphicsAreaParamEntry = {
    AreaName: string;
    CubeMapUnitName: string;
    LerpStep: number;
    PresetName: string;
    SuffixName: string;
};
type GraphicsArea = {
    GraphicsAreaParamArray: GraphicsAreaParamEntry[];
};
export type GraphicsPreset = {
    DirectionalLight: {
        Color: { A: number; B: number; G: number; R: number };
        DirectionParam: { X: number; Y: number; };
    }
    Sky: { Name: string };
    Fog: {
        Color: { R: number; G: number; B: number; A: number };
        Slope: number;
        Start: number;
        Max: number;
        IsEnable: boolean;
    };
    YFog: {
        Color: { R: number; G: number; B: number; A: number };
        Slope: number;
        Start: number;
        Max: number;
        DistanceSlopeScale: number;
        IsEnable: boolean;
    };
    HdrCompose: {
        AutoExposureBlendRateDown: number;
        AutoExposureBlendRateUp: number;
        AutoExposureHistogramScale: number;
        AutoExposureIgnoreRangeMax: number;
        AutoExposureIgnoreRangeMin: number;
        AutoExposureMid: number;
        AutoExposureRangeMax: number;
        AutoExposureRangeMin: number;
        BlackPoint: number;
        CameraEffectName: string;
        CrossOver: number;
        Exposure: number;
        LinearAngle: number;
        LinearStrength: number;
        Sholuder: number;
        ShoulderStrength: number;
        Toe: number;
        ToeDenominator: number;
        ToeNumerator: number;
        ToeStrength: number;
        ToneMapPowerBase: { X: number; Y: number; Z: number };
        ToneMapType: number;
        ToonShadeRate: number;
        ToonStep: { X: number; Y: number; Z: number };
        ToonWidth: { X: number; Y: number; Z: number };
        WhitePoint: number;
    };
}

function calcModelMtxFromTRSVectors(dst: mat4, tv: Vector, rv: Vector, sv: Vector): void {
    computeModelMatrixSRT(dst,
        sv.X, sv.Y, sv.Z,
        rv.X * MathConstants.DEG_TO_RAD, rv.Y * MathConstants.DEG_TO_RAD, rv.Z * MathConstants.DEG_TO_RAD,
        tv.X, tv.Y, tv.Z);
}

export class OdysseyRenderer extends BasicFRESRenderer {
    public static graphicsPreset: GraphicsPreset | null = null;

    constructor(device: GfxDevice, private resourceSystem: ResourceSystem) {
        super(device, resourceSystem.textureHolder);
    }

    public override destroy(device: GfxDevice): void {
        super.destroy(device);
        this.resourceSystem.destroy(device);
    }

    public setGraphicsPreset(preset: GraphicsPreset): void {
        OdysseyRenderer.graphicsPreset = preset;
    }

    public adjustCameraController(c: CameraController) {
        c.setSceneMoveSpeedMult(1.5);
    }
}

export class OdysseySceneDesc implements Viewer.SceneDesc {
    constructor(public id: string, public name: string = id, public scenarioIndex: number = 1) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        const resourceSystem = new ResourceSystem(device);
        const dataFetcher = context.dataFetcher;

        const worldListSARC = assertExists(await resourceSystem.fetchData(device, dataFetcher, `SystemData/WorldList`));
        type WorldListFromDb = { Name: string, StageList: [{ category: string, name: string }], WorldName: string, ScenarioNum: number, ClearMainScenario: number, AfterEndingScenario: number, MoonRockScenario: number };
        const worldList: WorldListFromDb[] = BYML.parse(worldListSARC.files.find((f) => f.name === 'WorldListFromDb.byml')!.buffer);

        // Find the right world from the stage given.
        function findWorldFromStage(worldList: WorldListFromDb[], stageName: string) {
            for (let i = 0; i < worldList.length; i++)
                for (let j = 0; j < worldList[i].StageList.length; j++)
                    if (worldList[i].StageList[j].name === stageName)
                        return worldList[i];
            return null;
        }
        const world = assertExists(findWorldFromStage(worldList, this.id));
        
        const sceneRenderer = new OdysseyRenderer(device, resourceSystem);
        const cache = sceneRenderer.renderHelper.renderCache;

        resourceSystem.fetchData(device, dataFetcher, `ObjectData/${world.Name}Texture`);

        const spawnZone = async (stageName: string, placement: mat4, isMap: boolean) => {
            console.log('Spawning stage:', stageName + (isMap ? ' (map)' : ''));

            const stageMapData = assertExists(await resourceSystem.fetchData(device, dataFetcher, `StageData/${stageName}Map`));
            const stageMap: StageMap = BYML.parse(assertExists(stageMapData.files.find((n) => n.name === `${stageName}Map.byml`)).buffer);

            let scenarioIndex: number;
            if (this.scenarioIndex !== null && !Number.isNaN(this.scenarioIndex)) {
                const maxIndex = stageMap.length > 0 ? stageMap.length - 1 : 0;
                scenarioIndex = Math.max(0, Math.min(this.scenarioIndex, maxIndex));
            } else {
                const scenarioNum = world.AfterEndingScenario;
                // It seems like the scenarios are 1-indexed, and 0 means "default" (which appears to be 1).
                scenarioIndex = scenarioNum > 0 ? scenarioNum - 1 : 0;
                const maxIndex = stageMap.length > 0 ? stageMap.length - 1 : 0;
                scenarioIndex = Math.max(0, Math.min(scenarioIndex, maxIndex));
            }
            const entry = stageMap[scenarioIndex];

            if (isMap) {
                const stageDesignData = assertExists(await resourceSystem.fetchData(device, dataFetcher, `StageData/${stageName}Design`));
                const stageDesign: GraphicsArea = BYML.parse(assertExists(stageDesignData.files.find((n) => n.name === `GraphicsArea.byml`)).buffer);

                console.log(scenarioIndex);

                let stageDesignParam = stageDesign.GraphicsAreaParamArray[scenarioIndex - 1];
                
                if (stageDesignParam.AreaName === "") {
                    stageDesignParam = stageDesign.GraphicsAreaParamArray[0];
                }

                console.log('Stage Design:', stageDesign);
                console.log('Stage Design Param:', stageDesignParam);
                
                const cubeMapUnitName = stageDesignParam.CubeMapUnitName;
                const suffixName = stageDesignParam.SuffixName;
                const presetName = stageDesignParam.PresetName;

                sceneRenderer.textureHolder.cubeMapSuffixName = suffixName;

                const graphicsPresetSARC = await resourceSystem.fetchData(device, dataFetcher, `SystemData/GraphicsPreset`);
                console.log('Graphics Preset:', graphicsPresetSARC);
                let graphicsPreset: GraphicsPreset | null = null;
                for (let i = 0; i < graphicsPresetSARC!.files.length; i++) {
                    const file = graphicsPresetSARC!.files[i];
                    const filePresetName: string = file.name.replace('.byml', '');
                    if (filePresetName === `${presetName}`) {
                        graphicsPreset = BYML.parse(file.buffer);
                        break;
                    }
                }

                console.log(graphicsPreset);

                if (graphicsPreset) {
                    const skyLocation = `ObjectData/${graphicsPreset.Sky.Name}`;
                    sceneRenderer.setGraphicsPreset(graphicsPreset);
                    resourceSystem.fetchData(device, dataFetcher, skyLocation);

                    await resourceSystem.waitForLoad();

                    const skyFmdlData = resourceSystem.getFMDLData(device, skyLocation);
                    if (skyFmdlData !== null) {
                        const skyRenderer = new SkyRenderer(device, cache, resourceSystem.textureHolder, skyFmdlData, graphicsPreset.Sky.Name);
                        mat4.copy(skyRenderer.modelMatrix, placement);
                        
                        const preset = OdysseyRenderer.graphicsPreset!;
                        const dir = latLonToDirection(preset.DirectionalLight.DirectionParam.Y, preset.DirectionalLight.DirectionParam.X);
                        mat4.rotateY(skyRenderer.modelMatrix, skyRenderer.modelMatrix, (180 * MathConstants.DEG_TO_RAD) + dir.z);
                        
                        sceneRenderer.skyRenderers.push(skyRenderer);
                    }

                    const preset = OdysseyRenderer.graphicsPreset!;
                    const color = preset.DirectionalLight.Color;
                    const lightColor = { r: color.R, g: color.G, b: color.B, a: color.A * 255.0 };

                    resourceSystem.textureHolder.addLUTTexture(device, 16, lightColor);
                }

                resourceSystem.fetchData(device, dataFetcher, `ObjectData/CubeMap${stageName}`);

                if (entry.SkyList !== undefined) {
                    for (let i = 0; i < entry.SkyList.length; i++) {
                        resourceSystem.fetchData(device, dataFetcher, `ObjectData/${entry.SkyList[i].UnitConfigName}`); // Clouds
                    }
                }

                await resourceSystem.waitForLoad();

                if (entry.SkyList !== undefined) {
                    for (let i = 0; i < entry.SkyList.length; i++) {
                        const skyEntry = entry.SkyList[i];
                        const fmdlData = resourceSystem.getFMDLData(device, `ObjectData/${skyEntry.UnitConfigName}`);
                        if (fmdlData === null)
                            continue;

                        const fmdlRenderer = new FMDLRenderer(device, cache, resourceSystem.textureHolder, fmdlData, `${skyEntry.UnitConfigName}`);
                        calcModelMtxFromTRSVectors(fmdlRenderer.modelMatrix, skyEntry.Translate, skyEntry.Rotate, skyEntry.Scale);
                        mat4.mul(fmdlRenderer.modelMatrix, placement, fmdlRenderer.modelMatrix);
                        sceneRenderer.fmdlRenderers.push(fmdlRenderer);
                    }
                }
            }

            if (entry.ObjectList !== undefined) {
                for (let i = 0; i < entry.ObjectList.length; i++) {
                    const stageObject = entry.ObjectList[i];
                    const objectName = (stageObject as any).ModelName ?? stageObject.UnitConfigName;
                    resourceSystem.fetchData(device, dataFetcher, `ObjectData/${objectName}`);
                }
            }
            if (entry.ZoneList !== undefined) {
                for (let i = 0; i < entry.ZoneList.length; i++)
                    resourceSystem.fetchData(device, dataFetcher, `StageData/${entry.ZoneList[i].UnitConfigName}Map`);
            }

            await resourceSystem.waitForLoad();

            if (entry.ObjectList !== undefined) {
                for (let i = 0; i < entry.ObjectList.length; i++) {
                    const stageObject = entry.ObjectList[i];
                    const objectName = (stageObject as any).ModelName ?? stageObject.UnitConfigName;
                    const fmdlData = resourceSystem.getFMDLData(device, `ObjectData/${objectName}`);
                    if (fmdlData === null)
                        continue;

                    const fmdlRenderer = new FMDLRenderer(device, cache, resourceSystem.textureHolder, fmdlData, `${objectName}`);
                    calcModelMtxFromTRSVectors(fmdlRenderer.modelMatrix, stageObject.Translate, stageObject.Rotate, stageObject.Scale);
                    mat4.mul(fmdlRenderer.modelMatrix, placement, fmdlRenderer.modelMatrix);
                    sceneRenderer.fmdlRenderers.push(fmdlRenderer);
                }
            }

            if (entry.ZoneList !== undefined) {
                for (let i = 0; i < entry.ZoneList.length; i++) {
                    console.log('Spawning zone:', entry.ZoneList[i].UnitConfigName);
                    const zoneEntry = entry.ZoneList[i];
                    const zonePlacement = mat4.create();
                    calcModelMtxFromTRSVectors(zonePlacement, zoneEntry.Translate, zoneEntry.Rotate, zoneEntry.Scale);
                    mat4.mul(zonePlacement, placement, zonePlacement);
                    spawnZone(`${zoneEntry.UnitConfigName}`, zonePlacement, false);
                }
            }
        };

        await spawnZone(this.id, mat4.create(), true);
        await resourceSystem.waitForLoad();

        return sceneRenderer;
    }
}

const name = "Super Mario Odyssey";
const id = "smo";
const sceneDescs = [
    "Cap Kingdom",
    new OdysseySceneDesc("CapWorldHomeStage", "Cap Kingdom - First Visit", 1),
    new OdysseySceneDesc("CapWorldHomeStage", "Cap Kingdom - Revisit/Peace", 2),
    new OdysseySceneDesc("CapWorldHomeStage", "Cap Kingdom - Post-game", 3),
    new OdysseySceneDesc("CapWorldHomeStage", "Cap Kingdom - Moon Rock", 4),
    new OdysseySceneDesc("CapWorldHomeStage", "Cap Kingdom - Balloon World", 5),
    new OdysseySceneDesc("CapWorldHomeStage", "Cap Kingdom - KFR", 6),
    new OdysseySceneDesc("CapWorldHomeStage", "Cap Kingdom - Trailer", 7),
    new OdysseySceneDesc("CapWorldTowerStage", "Cap Tower"),
    new OdysseySceneDesc("RollingExStage", "Rolling Sublevel"),
    new OdysseySceneDesc("PoisonWaveExStage", "Poison Tide Sublevel"),
    new OdysseySceneDesc("PushBlockExStage", "Push-Block Sublevel"),
    new OdysseySceneDesc("FrogSearchExStage", "Frog Pond Sublevel"),

    "Cascade Kingdom",
    new OdysseySceneDesc("WaterfallWorldHomeStage", "Cascade - First Visit", 1),
    new OdysseySceneDesc("WaterfallWorldHomeStage", "Cascade - Revisit/Peace", 2),
    new OdysseySceneDesc("WaterfallWorldHomeStage", "Cascade - Post-game", 3),
    new OdysseySceneDesc("WaterfallWorldHomeStage", "Cascade - Moon Rock", 4),
    new OdysseySceneDesc("WaterfallWorldHomeStage", "Cascade - KFR", 5),
    new OdysseySceneDesc("WaterfallWorldHomeStage", "Cascade - Balloon World", 6),
    new OdysseySceneDesc("WaterfallWorldHomeStage", "Cascade - E3/Trailer", 8),
    new OdysseySceneDesc("CapAppearExStage", "Mysterious Clouds Sublevel"),
    new OdysseySceneDesc("WanwanClashExStage", "Chain Chomp Cave Sublevel"),
    new OdysseySceneDesc("Lift2DExStage", "Chasm Lifts Sublevel"),
    new OdysseySceneDesc("WindBlowExStage", "Gusty Bridges Sublevel"),
    new OdysseySceneDesc("TrexPoppunExStage", "Dinosaur Nest Sublevel"),

    "Sand Kingdom",
    new OdysseySceneDesc("SandWorldHomeStage", "Sand - First Visit", 1),
    new OdysseySceneDesc("SandWorldHomeStage", "Sand - Night", 2),
    new OdysseySceneDesc("SandWorldHomeStage", "Sand - Peace", 3),
    new OdysseySceneDesc("SandWorldHomeStage", "Sand - Post-game", 4),
    new OdysseySceneDesc("SandWorldHomeStage", "Sand - Moon Rock", 5),
    new OdysseySceneDesc("SandWorldHomeStage", "Sand - Balloon World", 6),
    new OdysseySceneDesc("SandWorldHomeStage", "Sand - KFR", 7),
    new OdysseySceneDesc("SandWorldHomeStage", "Sand - Kiosk Demo", 8),
    new OdysseySceneDesc("SandWorldMeganeExStage", "Invisible Maze Sublevel"),
    new OdysseySceneDesc("SandWorldSphinxExStage", "Jaxi Ruins Underground"),
    new OdysseySceneDesc("SandWorldUnderground000Stage", "Underground Temple"),
    new OdysseySceneDesc("SandWorldUnderground001Stage", "Deepest Underground"),
    new OdysseySceneDesc("SandWorldKillerExStage", "Bullet Bill Maze Sublevel"),
    new OdysseySceneDesc("SandWorldShopStage", "Crazy Cap"),
    new OdysseySceneDesc("SandWorldPressExStage", "Ice Cave"),
    new OdysseySceneDesc("SandWorldPyramid000Stage", "Inverted Pyramid 1"),
    new OdysseySceneDesc("SandWorldPyramid001Stage", "Inverted Pyramid 2"),
    new OdysseySceneDesc("SandWorldCostumeStage", "Dance Room"),
    new OdysseySceneDesc("SandWorldRotateExStage", "Strange Neighborhood Sublevel"),
    new OdysseySceneDesc("SandWorldSlotStage", "Slots Room"),
    new OdysseySceneDesc("SandWorldSecretStage", "Sand Kingdom Secret Sublevel"),
    new OdysseySceneDesc("MeganeLiftExStage", "Transparent Platform Sublevel"),
    new OdysseySceneDesc("RocketFlowerExStage", "Colossal Ruins Sublevel"),
    new OdysseySceneDesc("WaterTubeExStage", "Freezing Waterway Sublevel"),
    new OdysseySceneDesc("SandWorldVibrationStage", "Rumbling Floor Sublevel"),

    "Wooded Kingdom",
    new OdysseySceneDesc("ForestWorldHomeStage", "Wooded - First Visit", 1),
    new OdysseySceneDesc("ForestWorldHomeStage", "Wooded - Post-Spewart", 2),
    new OdysseySceneDesc("ForestWorldHomeStage", "Wooded - Peace", 3),
    new OdysseySceneDesc("ForestWorldHomeStage", "Wooded - Post-game", 4),
    new OdysseySceneDesc("ForestWorldHomeStage", "Wooded - Moon Rock", 5),
    new OdysseySceneDesc("ForestWorldHomeStage", "Wooded - Balloon World", 6),
    new OdysseySceneDesc("ForestWorldHomeStage", "Wooded - KFR", 7),
    new OdysseySceneDesc("ForestWorldTowerStage", "Sky Garden Tower"),
    new OdysseySceneDesc("ForestWorldWaterExStage", "Flooding Pipeway Sublevel"),
    new OdysseySceneDesc("ForestWorldCloudBonusExStage", "Cloud Lift Bonus Stage"),
    new OdysseySceneDesc("ShootingElevatorExStage", "Elevator Shaft Sublevel"),
    new OdysseySceneDesc("FogMountainExStage", "Foggy Sky Sublevel"),
    new OdysseySceneDesc("ForestWorldBossStage", "Secret Flower Field (Boss)"),
    new OdysseySceneDesc("RailCollisionExStage", "Flower Road Sublevel"),
    new OdysseySceneDesc("AnimalChaseExStage", "Herding Path Sublevel"),
    new OdysseySceneDesc("ForestWorldWoodsStage", "Deep Woods"),
    new OdysseySceneDesc("ForestWorldWoodsTreasureStage", "Deep Woods (Treasure Chest Tree)"),
    new OdysseySceneDesc("PackunPoisonExStage", "Invisible Road Sublevel"),
    new OdysseySceneDesc("ForestWorldBonusStage", "Treasure Room"),
    new OdysseySceneDesc("ForestWorldWoodsCostumeStage", "Deep Woods (Treasure Chest Cave)"),
    new OdysseySceneDesc("KillerRoadExStage", "Breakdown Road Sublevel"),

    "Lake Kingdom",
    new OdysseySceneDesc("LakeWorldHomeStage", "Lake - First Visit", 1),
    new OdysseySceneDesc("LakeWorldHomeStage", "Lake - Peace", 2),
    new OdysseySceneDesc("LakeWorldHomeStage", "Lake - Post-game", 3),
    new OdysseySceneDesc("LakeWorldHomeStage", "Lake - Moon Rock", 4),
    new OdysseySceneDesc("LakeWorldHomeStage", "Lake - KFR", 5),
    new OdysseySceneDesc("LakeWorldHomeStage", "Lake - Balloon World", 6),
    new OdysseySceneDesc("LakeWorldShopStage", "Crazy Cap"),
    new OdysseySceneDesc("FrogPoisonExStage", "Waves of Poison Sublevel"),
    new OdysseySceneDesc("TrampolineWallCatchExStage", "Ledge Climbing Sublevel"),
    new OdysseySceneDesc("GotogotonExStage", "Puzzle Part Sublevel"),
    new OdysseySceneDesc("FastenerExStage", "Zipper Chasm Sublevel"),

    "Cloud Kingdom",
    new OdysseySceneDesc("CloudWorldHomeStage", "Cloud - First Visit", 1),
    new OdysseySceneDesc("CloudWorldHomeStage", "Cloud - Revisit/Peace", 2),
    new OdysseySceneDesc("CloudWorldHomeStage", "Cloud - Post-game", 3),
    new OdysseySceneDesc("CloudWorldHomeStage", "Cloud - Moon Rock", 4),
    new OdysseySceneDesc("CloudWorldHomeStage", "Cloud - KFR", 5),
    new OdysseySceneDesc("CloudWorldHomeStage", "Cloud - Balloon World", 6),
    new OdysseySceneDesc("Cube2DExStage", "2D Cube Sublevel"),
    new OdysseySceneDesc("FukuwaraiKuriboStage", "Goomba Picture Match Sublevel"),

    "Lost Kingdom",
    new OdysseySceneDesc("ClashWorldHomeStage", "Lost - First Visit", 1),
    new OdysseySceneDesc("ClashWorldHomeStage", "Lost - Revisit/Peace", 2),
    new OdysseySceneDesc("ClashWorldHomeStage", "Lost - Post-game", 3),
    new OdysseySceneDesc("ClashWorldHomeStage", "Lost - Moon Rock", 4),
    new OdysseySceneDesc("ClashWorldShopStage", "Crazy Cap"),
    new OdysseySceneDesc("ImomuPoisonExStage", "Poison Geyser Sublevel"),
    new OdysseySceneDesc("JangoExStage", "Klepto Lava Pit Sublevel"),

    "Metro Kingdom",
    new OdysseySceneDesc("CityWorldHomeStage", "Metro - Night", 1),
    new OdysseySceneDesc("CityWorldHomeStage", "Metro - Day", 2),
    new OdysseySceneDesc("CityWorldHomeStage", "Metro - Festival", 3),
    new OdysseySceneDesc("CityWorldHomeStage", "Metro - Peace", 4),
    new OdysseySceneDesc("CityWorldHomeStage", "Metro - Balloon World", 5),
    new OdysseySceneDesc("CityWorldHomeStage", "Metro - KFR", 6),
    new OdysseySceneDesc("CityWorldHomeStage", "Metro - Festival Revisit?", 7),
    new OdysseySceneDesc("CityWorldHomeStage", "Metro - Moon Rock", 8),
    new OdysseySceneDesc("CityWorldHomeStage", "Metro - KFR 2", 9),
    new OdysseySceneDesc("CityWorldHomeStage", "Metro - Morning Metro", 10),
    new OdysseySceneDesc("CityWorldHomeStage", "Metro - 8-Bit Festival", 11),
    new OdysseySceneDesc("CityWorldShop01Stage", "Crazy Cap"),
    new OdysseySceneDesc("Note2D3DRoomExStage", "Private Room 2D Sublevel"),
    new OdysseySceneDesc("CityWorldFactoryStage", "New Donk City Power Plant"),
    new OdysseySceneDesc("CityWorldMainTowerStage", "New Donk City Hall Interior"),
    new OdysseySceneDesc("PoleKillerExStage", "Bullet Bill Sublevel"),
    new OdysseySceneDesc("BikeSteelExStage", "Vanishing Road Sublevel"),
    new OdysseySceneDesc("CapRotatePackunExStage", "Rotating Maze Sublevel"),
    new OdysseySceneDesc("ElectricWireExStage", "Wiring Costume Sublevel"),
    new OdysseySceneDesc("CityWorldSandSlotStage", "Slots Room"),
    new OdysseySceneDesc("RadioControlExStage", "RC Car Room Sublevel"),
    new OdysseySceneDesc("ShootingCityExStage", "Siege Area Sublevel"),
    new OdysseySceneDesc("SwingSteelExStage", "Swinging Scaffolding Sublevel"),
    new OdysseySceneDesc("PoleGrabCeilExStage", "Swinging High-Rise Sublevel"),
    new OdysseySceneDesc("Theater2DExStage", "Projection Room Sublevel"),
    new OdysseySceneDesc("DonsukeExStage", "Pitchblack Mountain Sublevel"),
    new OdysseySceneDesc("CityPeopleRoadStage", "Crowded Alleyway Sublevel"),
    new OdysseySceneDesc("TrexBikeExStage", "T-Rex Chase Sublevel"),

    "Seaside Kingdom",
    new OdysseySceneDesc("SeaWorldHomeStage", "Seaside - First Visit", 1),
    new OdysseySceneDesc("SeaWorldHomeStage", "Seaside - Peace", 2),
    new OdysseySceneDesc("SeaWorldHomeStage", "Seaside - Post-game", 3),
    new OdysseySceneDesc("SeaWorldHomeStage", "Seaside - Moon Rock", 4),
    new OdysseySceneDesc("SeaWorldHomeStage", "Seaside - KFR", 5),
    new OdysseySceneDesc("SeaWorldHomeStage", "Seaside - Balloon World", 6),
    new OdysseySceneDesc("SeaWorldCostumeStage", "Beach House Costume Sublevel"),
    new OdysseySceneDesc("WaterValleyExStage", "Narrow Valley Sublevel"),
    new OdysseySceneDesc("SeaWorldSecretStage", "Sphynx's Underwater Vault"),
    new OdysseySceneDesc("CloudExStage", "Cloud Sea Sublevel"),
    new OdysseySceneDesc("SenobiTowerExStage", "Sinking Island Sublevel"),
    new OdysseySceneDesc("ReflectBombExStage", "Pokio Valley Sublevel"),
    new OdysseySceneDesc("TogezoRotateExStage", "Spinning Maze Sublevel"),
    new OdysseySceneDesc("SeaWorldSneakingManStage", "Flooded Cave Sublevel"),
    new OdysseySceneDesc("SeaWorldUtsuboCaveStage", "Underwater Tunnel Sublevel"),
    new OdysseySceneDesc("SeaWorldVibrationStage", "Rumbling Floor Sublevel"),

    "Snow Kingdom",
    new OdysseySceneDesc("SnowWorldHomeStage", "Snow - First Visit", 1),
    new OdysseySceneDesc("SnowWorldHomeStage", "Snow - Peace", 2),
    new OdysseySceneDesc("SnowWorldHomeStage", "Snow - Post-game", 3),
    new OdysseySceneDesc("SnowWorldHomeStage", "Snow - Moon Rock", 4),
    new OdysseySceneDesc("SnowWorldHomeStage", "Snow - Balloon World", 5),
    new OdysseySceneDesc("SnowWorldHomeStage", "Snow - KFR", 6),
    new OdysseySceneDesc("IceWaterBlockExStage", "Freezing Water Sublevel"),
    new OdysseySceneDesc("SnowWorldTownStage", "Shiveria Town"),
    new OdysseySceneDesc("ByugoPuzzleExStage", "Wooden Block Puzzle Sublevel"),
    new OdysseySceneDesc("IceWaterDashExStage", "Freezing Water Path Sublevel"),
    new OdysseySceneDesc("KillerRailCollisionExStage", "Flower Road Sublevel"),
    new OdysseySceneDesc("SnowWorldCloudBonusExStage", "Sky Bonus Sublevel"),
    new OdysseySceneDesc("SnowWorldLobby000Stage", "Bound Bowl Lobby: Regular Cup"),
    new OdysseySceneDesc("SnowWorldRaceExStage", "Bound Bowl: Regular Cup"),
    new OdysseySceneDesc("SnowWorldLobby001Stage", "Bound Bowl Lobby: Master Cup"),
    new OdysseySceneDesc("SnowWorldRaceHardExStage", "Bound Bowl: Master Cup"),
    new OdysseySceneDesc("SnowWorldRaceTutorialStage", "Bound Bowl Tutorial"),
    new OdysseySceneDesc("SnowWorldRace000Stage", "Bound Bowl Race 1"),
    new OdysseySceneDesc("SnowWorldRace001Stage", "Bound Bowl Race 2"),
    new OdysseySceneDesc("SnowWorldLobbyExStage", "Bound Bowl Race 3"),
    new OdysseySceneDesc("SnowWorldShopStage", "Crazy Cap"),
    new OdysseySceneDesc("IceWalkerExStage", "Trace-Walking Cave Sublevel"),
    new OdysseySceneDesc("SnowWorldCostumeStage", "Cold Room Costume Sublevel"),

    "Luncheon Kingdom",
    new OdysseySceneDesc("LavaWorldHomeStage", "Luncheon - First Visit", 1),
    new OdysseySceneDesc("LavaWorldHomeStage", "Luncheon - Post-Meat", 2),
    new OdysseySceneDesc("LavaWorldHomeStage", "Luncheon - Peace", 3),
    new OdysseySceneDesc("LavaWorldHomeStage", "Luncheon - Post-game", 4),
    new OdysseySceneDesc("LavaWorldHomeStage", "Luncheon - Volcano-less (1)", 5),
    new OdysseySceneDesc("LavaWorldHomeStage", "Luncheon - Volcano-less (2)", 6),
    new OdysseySceneDesc("LavaWorldHomeStage", "Luncheon - KFR", 7),
    new OdysseySceneDesc("LavaWorldHomeStage", "Luncheon - Moon Rock", 8),
    new OdysseySceneDesc("LavaWorldHomeStage", "Luncheon - Balloon World", 10),
    new OdysseySceneDesc("LavaWorldHomeStage", "Luncheon - Bruncheon", 11),
    new OdysseySceneDesc("LavaWorldUpDownExStage", "Magma Swap Sublevel"),
    new OdysseySceneDesc("LavaWorldBubbleLaneExStage", "Magma Narrow Path Sublevel"),
    new OdysseySceneDesc("LavaWorldFenceLiftExStage", "Lava Islands Sublevel"),
    new OdysseySceneDesc("LavaWorldClockExStage", "Spinning Athletics Sublevel"),
    new OdysseySceneDesc("LavaWorldExcavationExStage", "Cheese Rock Sublevel"),
    new OdysseySceneDesc("LavaWorldShopStage", "Crazy Cap"),
    new OdysseySceneDesc("DemoLavaWorldScenario1EndStage"),
    new OdysseySceneDesc("CapAppearLavaLiftExStage", "Volcano Cave Sublevel"),
    new OdysseySceneDesc("ForkExStage", "Fork Flickin' Mountain Sublevel"),
    new OdysseySceneDesc("GabuzouClockExStage", "Rotating Gear Sublevel"),
    new OdysseySceneDesc("LavaWorldTreasureStage", "Treasure Room"),
    new OdysseySceneDesc("LavaWorldCostumeStage", "Simmering Room Costume Sublevel"),

    "Ruined Kingdom",
    new OdysseySceneDesc("BossRaidWorldHomeStage", "Ruined - First Visit", 1),
    new OdysseySceneDesc("BossRaidWorldHomeStage", "Ruined - Peace", 2),
    new OdysseySceneDesc("BossRaidWorldHomeStage", "Ruined - Post-game", 3),
    new OdysseySceneDesc("BossRaidWorldHomeStage", "Ruined - Moon Rock", 4),
    new OdysseySceneDesc("BossRaidWorldHomeStage", "Ruined - Balloon World", 5),
    new OdysseySceneDesc("BossRaidWorldHomeStage", "Ruined - KFR", 6),
    new OdysseySceneDesc("BullRunExStage", "Chincho Army Sublevel"),
    new OdysseySceneDesc("DotTowerExStage", "Roulette Tower Sublevel"),

    "Bowser's Kingdom",
    new OdysseySceneDesc("SkyWorldHomeStage", "Bowser’s - First Visit", 1),
    new OdysseySceneDesc("SkyWorldHomeStage", "Bowser’s - Peace", 2),
    new OdysseySceneDesc("SkyWorldHomeStage", "Bowser’s - Post-game", 3),
    new OdysseySceneDesc("SkyWorldHomeStage", "Bowser’s - Moon Rock", 4),
    new OdysseySceneDesc("SkyWorldHomeStage", "Bowser’s - Balloon World", 5),
    new OdysseySceneDesc("SkyWorldHomeStage", "Bowser’s - KFR", 6),
    new OdysseySceneDesc("SkyWorldShopStage", "Crazy Cap"),
    new OdysseySceneDesc("SkyWorldCostumeStage", "Folding Screen Costume Sublevel"),
    new OdysseySceneDesc("TsukkunClimbExStage", "Wooden Tower Sublevel"),
    new OdysseySceneDesc("TsukkunRotateExStage", "Spinning Tower Sublevel"),
    new OdysseySceneDesc("JizoSwitchExStage", "Jizo Area Sublevel"),
    new OdysseySceneDesc("SkyWorldCloudBonusExStage", "Sky Slope Bonus Stage"),
    new OdysseySceneDesc("KaronWingTowerStage", "Hexagon Tower Sublevel"),
    new OdysseySceneDesc("SkyWorldTreasureStage", "Bowser's Castle Treasure Vault"),

    "Moon Kingdom",
    new OdysseySceneDesc("MoonWorldHomeStage", "Moon - Peace/Post-game", 1),
    new OdysseySceneDesc("MoonWorldHomeStage", "Moon - Moon Rock", 3),
    new OdysseySceneDesc("MoonWorldHomeStage", "Moon - Balloon World", 4),
    new OdysseySceneDesc("MoonWorldWeddingRoomStage", "Wedding Hall"),
    new OdysseySceneDesc("MoonWorldShopRoom", "Crazy Cap"),
    new OdysseySceneDesc("MoonWorldSphinxRoom", "Sphinx's Hidden Vault"),
    new OdysseySceneDesc("MoonWorldCaptureParadeStage", "Underground Moon Caverns"),
    new OdysseySceneDesc("MoonAthleticExStage", "Giant Swing Sublevel"),
    new OdysseySceneDesc("Galaxy2DExStage", "2D Galaxy Sublevel"),
    new OdysseySceneDesc("MoonWorldBasementStage", "Crumbling Cavern Bowser Stage"),
    new OdysseySceneDesc("MoonWorldKoopa1Stage", "Captured Bowser Stage Background"),

    "Mushroom Kingdom",
    new OdysseySceneDesc("PeachWorldHomeStage", "Mushroom - Mushroom", 1),
    new OdysseySceneDesc("PeachWorldHomeStage", "Mushroom - Post-game", 2),
    new OdysseySceneDesc("PeachWorldHomeStage", "Mushroom - World Peace?", 3),
    new OdysseySceneDesc("PeachWorldHomeStage", "Mushroom - KFR", 4),
    new OdysseySceneDesc("PeachWorldHomeStage", "Mushroom - Balloon World", 5),
    new OdysseySceneDesc("PeachWorldCastleStage", "Peach's Castle Interior"),
    new OdysseySceneDesc("PeachWorldShopStage", "Crazy Cap"),
    new OdysseySceneDesc("PeachWorldCostumeStage", "SM64 Castle Courtyard Sublevel"),
    new OdysseySceneDesc("YoshiCloudExStage", "Yoshi Cloud Sublevel"),
    new OdysseySceneDesc("FukuwaraiMarioStage", "Mario Picture Match Sublevel"),
    new OdysseySceneDesc("DotHardExStage", "Moving 2D Sublevel"),
    new OdysseySceneDesc("PeachWorldPictureBossMagmaStage", "Cookatiel's Rematch Painting Room"),
    new OdysseySceneDesc("PeachWorldPictureMofumofuStage", "Mechawiggler's Rematch Painting Room"),
    new OdysseySceneDesc("PeachWorldPictureBossRaidStage", "Ruined Dragon's Rematch Painting Room"),
    new OdysseySceneDesc("PeachWorldPictureBossForestStage", "Torkdrift's Rematch Painting Room"),
    new OdysseySceneDesc("PeachWorldPictureBossKnuckleStage", "Knucklotec's Rematch Painting Room"),
    new OdysseySceneDesc("PeachWorldPictureGiantWanderBossStage", "Mollusque-Lanceur's Rematch Painting Room"),
    new OdysseySceneDesc("RevengeBossMagmaStage", "Cookatiel's Rematch Sublevel"),
    new OdysseySceneDesc("RevengeMofumofuStage", "Mechawiggler's Rematch Sublevel"),
    new OdysseySceneDesc("RevengeBossRaidStage", "Ruined Dragon's Rematch Sublevel"),
    new OdysseySceneDesc("RevengeForestBossStage", "Torkdrift's Rematch Sublevel"),
    new OdysseySceneDesc("RevengeBossKnuckleStage", "Knucklotec's Rematch Sublevel"),
    new OdysseySceneDesc("RevengeGiantWanderBossStage", "Mollusque-Lanceur's Rematch Sublevel"),

    "Dark Side",
    new OdysseySceneDesc("Special1WorldHomeStage", "Dark Side - First Visit", 1),
    new OdysseySceneDesc("Special1WorldHomeStage", "Dark Side - Peace", 2),
    new OdysseySceneDesc("PackunPoisonNoCapExStage", "Invisible Road Sublevel"),
    new OdysseySceneDesc("KillerRoadNoCapExStage", "Breakdown Road Sublevel"),
    new OdysseySceneDesc("BikeSteelNoCapExStage", "Vanishing Road Sublevel"),
    new OdysseySceneDesc("SenobiTowerYoshiExStage", "Sinking Island Sublevel"),
    new OdysseySceneDesc("ShootingCityYoshiExStage", "Siege Sublevel, with Yoshi"),
    new OdysseySceneDesc("LavaWorldUpDownYoshiExStage", "Magma Swamp Sublevel"),
    new OdysseySceneDesc("Special1WorldTowerStackerStage", "Topper Rematch"),
    new OdysseySceneDesc("Special1WorldTowerBombTailStage", "Hariet Rematch"),
    new OdysseySceneDesc("Special1WorldTowerFireBlowerStage", "Spewart Rematch"),
    new OdysseySceneDesc("Special1WorldTowerCapThrowerStage", "Rango Rematch"),

    "Darker Side",
    new OdysseySceneDesc("Special2WorldHomeStage", "Darker Side - First Visit", 1),
    new OdysseySceneDesc("Special2WorldHomeStage", "Darker Side - Peace", 2),
    new OdysseySceneDesc("Special2WorldKoopaStage", "Darker Side Bowser Area"),
    new OdysseySceneDesc("Special2WorldLavaStage", "Darker Side Course Area"),
    new OdysseySceneDesc("Special2WorldCloudStage", "Darker Side Cloud Area"),

    "Duplicates",
    new OdysseySceneDesc("MoonWorldKoopa2Stage", "Captured Bowser Stage Background Duplicate"),
    new OdysseySceneDesc("MoonWorldWeddingRoom2Stage", "Wedding Hall Duplicate"),
];

export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs };
