export interface RippleColor {
    R: number;
    G: number;
    B: number;
    A: number;
}

export interface RippleVec2 {
    X: number;
    Y: number;
}

export interface RippleVec3 {
    X: number;
    Y: number;
    Z: number;
}

export interface RippleMatParam {
    MatName: string;
    ReplaceSlot: number;
    ReplaceType: number;
    TexName: string;
}

export interface RippleRangeParam {
    CollisionCheckGridSize: number;
    EmissionColor: RippleColor;
    FlowMapInterval: number;
    FlowMapSpeed: number;
    IsEnableCollisionCheck: boolean;
    IsEnableCollisionCheckOther: boolean;
    IsEnableEmission: boolean;
    RangeOffset: RippleVec3;
    RangeRotate: RippleVec3;
    RangeSize: RippleVec3;
}

export interface RippleTexParam {
    Damp: number;
    DefaultRangeIn: number;
    DefaultRangeOut: number;
    FlowSlideUv: RippleVec2;
    IsDampInRange: boolean;
    IsFixed: boolean;
    IsForceNegative: boolean;
    IsUseAbsNormalTex: boolean;
    IsUseDisplacementTex: boolean;
    IsUseGradTex: boolean;
    IsUseHeightTex: boolean;
    IsUseNoise: boolean;
    IsUseNormalTex: boolean;
    IsUsePatternTex: boolean;
    MaterialTemplateType: number;
    NoiseId: number;
    NoiseTexCrdScale: number;
    NoiseVelocity: RippleVec3;
    PointSpriteType: number;
    RippleScale: number;
    RippleSizeScale: number;
    Speed: number;
    TextureRange: number;
    TextureSize: number;
    Viscocity: number;
}

export interface InitRippleParam {
    RippleMatParams: RippleMatParam[];
    RippleRangeParams: RippleRangeParam;
    RippleTexParams: RippleTexParam[];
}

function num(v: any, fallback = 0): number {
    return typeof v === 'number' ? v : fallback;
}

function bool(v: any, fallback = false): boolean {
    return typeof v === 'boolean' ? v : fallback;
}

function str(v: any, fallback = ''): string {
    return typeof v === 'string' ? v : fallback;
}

function vec2(v: any): RippleVec2 {
    return { X: num(v?.X), Y: num(v?.Y) };
}

function vec3(v: any): RippleVec3 {
    return { X: num(v?.X), Y: num(v?.Y), Z: num(v?.Z) };
}

function color(v: any): RippleColor {
    return { R: num(v?.R), G: num(v?.G), B: num(v?.B), A: num(v?.A, 1) };
}

function parseRippleMatParam(v: any): RippleMatParam {
    return {
        MatName: str(v?.MatName),
        ReplaceSlot: num(v?.ReplaceSlot),
        ReplaceType: num(v?.ReplaceType),
        TexName: str(v?.TexName),
    };
}

function parseRippleRangeParam(v: any): RippleRangeParam {
    return {
        CollisionCheckGridSize: num(v?.CollisionCheckGridSize),
        EmissionColor: color(v?.EmissionColor),
        FlowMapInterval: num(v?.FlowMapInterval),
        FlowMapSpeed: num(v?.FlowMapSpeed),
        IsEnableCollisionCheck: bool(v?.IsEnableCollisionCheck),
        IsEnableCollisionCheckOther: bool(v?.IsEnableCollisionCheckOther),
        IsEnableEmission: bool(v?.IsEnableEmission),
        RangeOffset: vec3(v?.RangeOffset),
        RangeRotate: vec3(v?.RangeRotate),
        RangeSize: vec3(v?.RangeSize),
    };
}

function parseRippleTexParam(v: any): RippleTexParam {
    return {
        Damp: num(v?.Damp),
        DefaultRangeIn: num(v?.DefaultRangeIn),
        DefaultRangeOut: num(v?.DefaultRangeOut),
        FlowSlideUv: vec2(v?.FlowSlideUv),
        IsDampInRange: bool(v?.IsDampInRange),
        IsFixed: bool(v?.IsFixed),
        IsForceNegative: bool(v?.IsForceNegative),
        IsUseAbsNormalTex: bool(v?.IsUseAbsNormalTex),
        IsUseDisplacementTex: bool(v?.IsUseDisplacementTex),
        IsUseGradTex: bool(v?.IsUseGradTex),
        IsUseHeightTex: bool(v?.IsUseHeightTex),
        IsUseNoise: bool(v?.IsUseNoise),
        IsUseNormalTex: bool(v?.IsUseNormalTex),
        IsUsePatternTex: bool(v?.IsUsePatternTex),
        MaterialTemplateType: num(v?.MaterialTemplateType),
        NoiseId: num(v?.NoiseId),
        NoiseTexCrdScale: num(v?.NoiseTexCrdScale),
        NoiseVelocity: vec3(v?.NoiseVelocity),
        PointSpriteType: num(v?.PointSpriteType),
        RippleScale: num(v?.RippleScale),
        RippleSizeScale: num(v?.RippleSizeScale),
        Speed: num(v?.Speed),
        TextureRange: num(v?.TextureRange),
        TextureSize: num(v?.TextureSize),
        Viscocity: num(v?.Viscocity),
    };
}

export function parseInitRippleParam(raw: any): InitRippleParam {
    const root = (raw?.root && typeof raw.root === 'object') ? raw.root : raw;
    return {
        RippleMatParams: Array.isArray(root?.RippleMatParams) ? root.RippleMatParams.map(parseRippleMatParam) : [],
        RippleRangeParams: parseRippleRangeParam(root?.RippleRangeParams),
        RippleTexParams: Array.isArray(root?.RippleTexParams) ? root.RippleTexParams.map(parseRippleTexParam) : [],
    };
}

export function findRippleMatParams(param: InitRippleParam | null, matName: string): RippleMatParam[] {
    if (param === null)
        return [];
    return param.RippleMatParams.filter((p) => p.MatName === matName && p.TexName !== '');
}
