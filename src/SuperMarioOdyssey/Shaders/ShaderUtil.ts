import { GfxShaderLibrary } from "../../gfx/helpers/GfxShaderLibrary";

export function generateShaderUtil(): string {
    return `
${GfxShaderLibrary.MatrixLibrary}
${GfxShaderLibrary.saturate}

const float PI = 3.1415926535897932384626433832795;
const float INV_PI = 0.31830988618;
const float EULERS_NUMBER = 2.71828182845904;

float fma(float a, float b, float c) {
    return (a * b) + c;
}

vec3 fma(vec3 a, vec3 b, vec3 c) {
    return (a * b) + c;
}

vec4 fma(vec4 a, vec4 b, vec4 c) {
    return (a * b) + c;
}

#define clamp01(val)	clamp((val), 0.0, 1.0)
#define dot2(a, b)	((a).x * (b).x + (a).y * (b).y)
#define dot3(a, b)	(dot2((a), (b)) + (a).z * (b).z)
#define dot4(a, b)	(dot3((a), (b)) + (a).w * (b).w)
#define calcDotVec4Vec3One(a, b)	(dot3((a), (b)) + (a).w)

vec4 multMtx44Vec4(Mat4x4 mtx, vec4 v)
{
    vec4 ret;
    ret.x = dot(mtx.mx, v);
    ret.y = dot(mtx.my, v);
    ret.z = dot(mtx.mz, v);
    ret.w = dot(mtx.mw, v);
    return ret;
}

vec4 multMtx44Vec3(Mat4x4 mtx, vec3 v)
{
    vec4 ret;
    ret.x = calcDotVec4Vec3One(mtx.mx, v);
    ret.y = calcDotVec4Vec3One(mtx.my, v);
    ret.z = calcDotVec4Vec3One(mtx.mz, v);
    ret.w = calcDotVec4Vec3One(mtx.mw, v);
    return ret;
}

vec4 multMtx34Vec4(Mat3x4 mtx, vec4 v)
{
    vec4 ret;
    ret.x = dot(mtx.mx, v);
    ret.y = dot(mtx.my, v);
    ret.z = dot(mtx.mz, v);
    ret.w = 1.0;
    return ret;
}

vec3 multMtx34Vec3(Mat3x4 mtx, vec3 v)
{
    vec3 ret;
    ret.x = calcDotVec4Vec3One(mtx.mx, v);
    ret.y = calcDotVec4Vec3One(mtx.my, v);
    ret.z = calcDotVec4Vec3One(mtx.mz, v);
    return ret;
}

vec3 rotMtx34Vec3(Mat3x4 mtx, vec3 v)
{
    vec3 ret;
    ret.x = dot3(mtx.mx, v);
    ret.y = dot3(mtx.my, v);
    ret.z = dot3(mtx.mz, v);
    return ret;
}

vec2 multMtx24Vec2(Mat2x4 mtx, vec2 v)
{
    return vec2(mtx.mx.xy * v.x + mtx.mx.zw * v.y + mtx.my.xy);
}
`
};
