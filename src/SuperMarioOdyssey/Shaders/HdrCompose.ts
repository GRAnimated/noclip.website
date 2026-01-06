import { vec4 } from 'gl-matrix';
import { GfxBindingLayoutDescriptor, GfxSamplerFormatKind, GfxTextureDimension } from '../../gfx/platform/GfxPlatform.js';
import { DeviceProgram } from '../../Program.js';
import { GraphicsPreset, OdysseyRenderer, OdysseySceneDesc } from '../Scenes.js';
import { generateShaderUtil } from './ShaderUtil.js';

export class HdrCompose extends DeviceProgram {
    public static ub_HdrComposeInfo = 0;
    toneMapType: number = 8; // temp

    public static bindingLayouts: GfxBindingLayoutDescriptor[] = [
        {
            numUniformBuffers: 1, numSamplers: 2, samplerEntries: [
                { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.UnfilterableFloat },
                { dimension: GfxTextureDimension.n2D, formatKind: GfxSamplerFormatKind.UnfilterableFloat },
            ]
        }
    ];

    private genToneMapType(): string {
        return this.toneMapType.toString();
    }

    public override both = generateShaderUtil() + `
layout(std140) uniform ub_HdrComposeInfo {
    vec4 uCameraMaskDiffuse;
    float uExposure;
    float uCameraMaskBase;
    float uCameraMaskScale;
    float uCameraIndirectScale;
    float uCameraIndirect2Scale;
    float uChromaticAberrationSize;
    vec2 uCameraMaskTexOffset;
    vec2 uCameraMaskTexScale;
    vec2 uCameraIndirectOffset;
    vec2 uCameraIndirect2Offset;
    vec2 uCameraIndirectTexScale;
    vec2 uCameraIndirect2TexScale;
    vec2 uColorCorrectionCoeff;
    vec3 uToneMapPowBase;
    float uToonShadeRate;
    vec3 uToonStep;
    vec3 uToonWidth;
    float uShoulderStrength;
    float uLinearStrength;
    float uLinearAngle;
    float uToeStrength;
    float uToeNumerator;
    float uToeDenominator;
    float uCrossOver;
    vec4 uToeCoeff;
    vec4 uSholuderCoeff;
    vec4 uLumaCoeff;
};

uniform sampler2D uHdrImage;
uniform sampler2D uExposureTexture;
`;

    public override vert = `
layout(location = 0) in vec4 aPosition;
layout(location = 1) in vec2 aTexCoord;

out vec2 vTexCoord;
out vec4 vExposure;

void main() {
    // gl_Position = vec4(aPosition.xy * 2.0, 0.0, 1.0);
    gl_Position = aPosition;
    vTexCoord = aTexCoord;
    vExposure = texture(uExposureTexture, vec2(0.0));
    vExposure.a *= uExposure;
}
`;

    public override frag = `
in vec2 vTexCoord;
in vec4 vExposure;

out vec4 oColor;

void main ( void )
{
	float exposure = vExposure.a;

	vec2 tex_coord = vTexCoord;

	vec4 hdr_color = texture(uHdrImage, tex_coord);
	hdr_color.rgb *= exposure;

	vec3 light_buf = vec3(0.0);

	int TONE_MAP_TYPE = ${this.genToneMapType()};

	vec3 tone_map_color;
	if (TONE_MAP_TYPE == 0) // Linear
	{
		tone_map_color = hdr_color.rgb + light_buf;
	}
	else if (TONE_MAP_TYPE == 1) // Exposure
	{
		tone_map_color = hdr_color.rgb + light_buf;
		tone_map_color = 1.0 - exp(-tone_map_color);
	}
	else if (TONE_MAP_TYPE == 2) // Exposure Atmos
	{
		tone_map_color = hdr_color.rgb + light_buf;
		tone_map_color.r = tone_map_color.r < 1.413 ? pow(tone_map_color.r * 0.38317, 1.0/2.2) : 1.0 - exp(-tone_map_color.r);
		tone_map_color.g = tone_map_color.g < 1.413 ? pow(tone_map_color.g * 0.38317, 1.0/2.2) : 1.0 - exp(-tone_map_color.g);
		tone_map_color.b = tone_map_color.b < 1.413 ? pow(tone_map_color.b * 0.38317, 1.0/2.2) : 1.0 - exp(-tone_map_color.b);
	}
	else if (TONE_MAP_TYPE == 3) // Reinhard
	{
		tone_map_color = hdr_color.rgb + light_buf;
		tone_map_color = tone_map_color / ( 1.0 + tone_map_color );
	}
	else if (TONE_MAP_TYPE == 4) // Filmic
	{
		vec3 raw_color = hdr_color.rgb + light_buf;
		tone_map_color = max( raw_color - 0.004, 0.0 );
		vec3 tmp = raw_color * 6.2;
		tone_map_color = ( raw_color * ( tmp + 0.5 ) ) / ( raw_color * ( tmp + 1.7 ) + 0.06 );
	}
	else if (TONE_MAP_TYPE == 5) // Filmic Param
	{
		vec3 raw_color = hdr_color.rgb + light_buf;
		tone_map_color = ((raw_color*(uShoulderStrength*raw_color+uLinearAngle*uLinearStrength)+uToeStrength*uToeNumerator)/(raw_color*(uShoulderStrength*raw_color+uLinearStrength)+uToeStrength*uToeDenominator))-uToeNumerator/uToeDenominator;
	}
	else if (TONE_MAP_TYPE == 6) // Pow
	{
		tone_map_color = hdr_color.rgb + light_buf;
		tone_map_color = 1.0 - pow(uToneMapPowBase, -tone_map_color);
	}
	else if (TONE_MAP_TYPE == 7) // Exposure Coef
	{
		tone_map_color = hdr_color.rgb + light_buf;
		tone_map_color = 1.0 - exp(-uToneMapPowBase*tone_map_color);
	}
	else if (TONE_MAP_TYPE == 8) // S-Curve
	{
		vec3 raw_color = hdr_color.rgb + light_buf;
		vec4 coeff = ( raw_color.r < uCrossOver ) ? uToeCoeff : uSholuderCoeff;
		vec2 fract = coeff.xy * raw_color.r + coeff.zw;
		tone_map_color.r = fract.x / fract.y;
		coeff = ( raw_color.g < uCrossOver ) ? uToeCoeff : uSholuderCoeff;
		fract = coeff.xy * raw_color.g + coeff.zw;
		tone_map_color.g = fract.x / fract.y;
		coeff = ( raw_color.b < uCrossOver ) ? uToeCoeff : uSholuderCoeff;
		fract = coeff.xy * raw_color.b + coeff.zw;
		tone_map_color.b = fract.x / fract.y;
	}

	// Color Correction

	int COLOR_CORRECTION_TYPE = 0; // TODO: pass in as uniform
	if (COLOR_CORRECTION_TYPE == 1)
	{
		vec3 xyz = tone_map_color * uColorCorrectionCoeff.x + uColorCorrectionCoeff.y;
        // TODO: uColorCorrectionTable
		// tone_map_color = texture(uColorCorrectionTable, xyz).rgb;
	}

	int USING_CARTOON = 0; // TODO: pass in as uniform
	
	// Since the cartoon effect is calculated after tone mapping,
	// it's also affected by post-processing effects.
	if (USING_CARTOON == 1)
	{
		// Calculate the luminance. The range should be [0, 1] after tone mapping.
		const vec3 coef_lumi = vec3(0.298912, 0.586611, 0.114477);
		float lumi = clamp01(dot(tone_map_color, coef_lumi));
		vec3 dark = tone_map_color * tone_map_color * tone_map_color * tone_map_color;

		vec3 rate3 = smoothstep(uToonStep, uToonStep + uToonWidth, vec3(lumi));
		float rate = (rate3.x + rate3.y + rate3.z) * 0.33333;
		/*
		float rate = smoothstep(uToonCoef.x, uToonCoef.y, lumi) * 0.333;
		rate += smoothstep(uToonCoef.z, uToonCoef.w, lumi) * 0.333;
		rate += smoothstep(uToonCoef2.x, uToonCoef2.y, lumi) * 0.333;
		*/
		tone_map_color = mix(dark, tone_map_color, max(clamp01(rate), clamp01(1.0 - uToonShadeRate)));
	}

	oColor.rgb = tone_map_color;
	oColor.a = hdr_color.a;
}
`;
}
type SCurveCoeffs = {
    toe: [number, number, number, number];
    shoulder: [number, number, number, number];
};

// Filmic Param from the shader
function evalFilmicParam(x: number, S: number, Ls: number, La: number, T: number, Tn: number, Td: number): number {
    const Nx = x * (S * x + La * Ls) + T * Tn;
    const Dx = x * (S * x + Ls)     + T * Td;
    if (Dx === 0.0) return 0.0;
    return Nx / Dx - Tn / Td;
}

// Numeric derivative of Filmic Param at x
function evalFilmicParamSlope(x: number, S: number, Ls: number, La: number, T: number, Tn: number, Td: number): number {
    const h = Math.max(1e-3, x * 0.01);
    const y1 = evalFilmicParam(x - h, S, Ls, La, T, Tn, Td);
    const y2 = evalFilmicParam(x + h, S, Ls, La, T, Tn, Td);
    return (y2 - y1) / (2 * h);
}

// Matches Filmic at 0, C, and W and tries to keep Filmic's slope at C
function computeSCurveCoeffsFromPreset(hdr: GraphicsPreset['HdrCompose']): SCurveCoeffs {
    const C  = hdr.CrossOver;
    const T  = hdr.ToeStrength;
    const S  = hdr.ShoulderStrength;
    const Ls = hdr.LinearStrength;
    const La = hdr.LinearAngle;
    const Tn = hdr.ToeNumerator;
    const Td = hdr.ToeDenominator;

    const y0     = evalFilmicParam(0.0, S, Ls, La, T, Tn, Td);
    const yC     = evalFilmicParam(C,   S, Ls, La, T, Tn, Td);
    const slopeC = evalFilmicParamSlope(C, S, Ls, La, T, Tn, Td);

    // White point
    const W = C + 6.0;
    const yW = evalFilmicParam(W, S, Ls, La, T, Tn, Td);

    // Toe
    const dToe = 1.0;
    const bToe = 0.01 + T * 0.05; // small curvature to keep close to Filmic
    const cToe = y0 * dToe;
    const aToe = (yC * (bToe * C + dToe) - cToe) / C;

    const toe: [number, number, number, number] = [
        aToe,
        bToe,
        cToe,
        dToe,
    ];

    // Shoulder
    const dShoulder = 1.0;
    const bShoulder = 0.01 + S * 0.05; // small curvature to keep close to Filmic

    const C1 = yC * (bShoulder * C + dShoulder);
    const C2 = yW * (bShoulder * W + dShoulder);

    const det = C - W;
    let aShoulder: number;
    let cShoulder: number;

    if (Math.abs(det) > 0.0001) {
        aShoulder = (C1 - C2) / det;
        cShoulder = C1 - aShoulder * C;
    } else {
        // continue with Filmic's slope at C
        const slope = slopeC;
        aShoulder = slope * dShoulder;
        cShoulder = yC * dShoulder - aShoulder * C;
    }

    const shoulder: [number, number, number, number] = [aShoulder, bShoulder, cShoulder, dShoulder];

    return { toe, shoulder };
}

export function fillHdrComposeUniforms(d: Float32Array, offs: number, preset: GraphicsPreset): number {
    const hdr = preset.HdrCompose;

    // uCameraMaskDiffuse (vec4)
    d[offs++] = 0.0;
    d[offs++] = 0.0;
    d[offs++] = 0.0;
    d[offs++] = 0.0;
    
    const EXPOSURE_SCALE = 4000.0;

    // uExposure
    d[offs++] = hdr.Exposure * EXPOSURE_SCALE;
    
    // uCameraMaskBase
    d[offs++] = 0.0;
    
    // uCameraMaskScale
    d[offs++] = 0.0;
    
    // uCameraIndirectScale
    d[offs++] = 0.0;
    
    // uCameraIndirect2Scale
    d[offs++] = 0.0;
    
    // uChromaticAberrationSize
    d[offs++] = 0.0;
    
    // padding to align to vec2
    d[offs++] = 0.0;
    d[offs++] = 0.0;
    
    // uCameraMaskTexOffset (vec2)
    d[offs++] = 0.0;
    d[offs++] = 0.0;
    
    // uCameraMaskTexScale (vec2)
    d[offs++] = 1.0;
    d[offs++] = 1.0;
    
    // uCameraIndirectOffset (vec2)
    d[offs++] = 0.0;
    d[offs++] = 0.0;
    
    // uCameraIndirect2Offset (vec2)
    d[offs++] = 0.0;
    d[offs++] = 0.0;
    
    // uCameraIndirectTexScale (vec2)
    d[offs++] = 1.0;
    d[offs++] = 1.0;
    
    // uCameraIndirect2TexScale (vec2)
    d[offs++] = 1.0;
    d[offs++] = 1.0;
    
    // uColorCorrectionCoeff (vec2)
    d[offs++] = 1.0;
    d[offs++] = 0.0;
    
    // uToneMapPowBase (vec3)
    d[offs++] = hdr.ToneMapPowerBase.X;
    d[offs++] = hdr.ToneMapPowerBase.Y;
    d[offs++] = hdr.ToneMapPowerBase.Z;
    
    // uToonShadeRate
    d[offs++] = hdr.ToonShadeRate;
    
    // uToonStep (vec3)
    d[offs++] = hdr.ToonStep.X;
    d[offs++] = hdr.ToonStep.Y;
    d[offs++] = hdr.ToonStep.Z;
    
    // padding
    d[offs++] = 0.0;
    
    // uToonWidth (vec3)
    d[offs++] = hdr.ToonWidth.X;
    d[offs++] = hdr.ToonWidth.Y;
    d[offs++] = hdr.ToonWidth.Z;
    
    // uShoulderStrength
    d[offs++] = hdr.ShoulderStrength;
    
    // uLinearStrength
    d[offs++] = hdr.LinearStrength;
    
    // uLinearAngle
    d[offs++] = hdr.LinearAngle;
    
    // uToeStrength
    d[offs++] = hdr.ToeStrength;
    
    // uToeNumerator
    d[offs++] = hdr.ToeNumerator;
    
    // uToeDenominator
    d[offs++] = hdr.ToeDenominator;
    
    // uCrossOver
    d[offs++] = hdr.CrossOver;

    const { toe, shoulder } = computeSCurveCoeffsFromPreset(hdr);

    // uToeCoeff (vec4)
    d[offs++] = toe[0];
    d[offs++] = toe[1];
    d[offs++] = toe[2];
    d[offs++] = toe[3];

    // uSholuderCoeff (vec4)
    d[offs++] = shoulder[0];
    d[offs++] = shoulder[1];
    d[offs++] = shoulder[2];
    d[offs++] = shoulder[3];
    
    // uLumaCoeff (vec4)
    d[offs++] = 0.0;
    d[offs++] = 0.0;
    d[offs++] = 0.0;
    d[offs++] = 0.0;
    
    return offs;
}