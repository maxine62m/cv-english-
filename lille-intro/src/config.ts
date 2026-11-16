// Paramètres globaux de l'intro : vidéo, lieux, clés API.
export const VIDEO = { width: 1920, height: 1080, fps: 30, duration: 20 } as const;

/** Centre-ville (origine du repère local ENU utilisé par les shaders). */
export const LILLE_CENTER = { lon: 3.0633, lat: 50.6372 };

/** Repères réels (coordonnées OpenStreetMap). */
export const PLACES = {
  grandPlace: { lon: 3.06344, lat: 50.6369, name: "Grand'Place (colonne de la Déesse)" },
  vieilleBourse: { lon: 3.06428, lat: 50.63705, name: 'Vieille Bourse' },
  beffroiHdV: { lon: 3.06977, lat: 50.63063, name: 'Beffroi de Lille (Hôtel de Ville, 104 m)' },
  beffroiCCI: { lon: 3.06451, lat: 50.63768, name: 'Beffroi de la Chambre de commerce (76 m)' },
  vieuxLille: { lon: 3.0623, lat: 50.6405, name: 'Vieux-Lille' },
} as const;

/** Altitude ellipsoïdale approximative du sol de la Grand'Place (≈22 m NGF + 45,6 m de géoïde). */
export const DEFAULT_GROUND_ELLIPSOID_HEIGHT = 67.5;

export const KEYS = {
  google: (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined)?.trim() || '',
  ion: (import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined)?.trim() || '',
};

/** Nuit d'hiver à Lille (22h30 locale) : ciel et atmosphère sombres. */
export const NIGHT_TIME_ISO = '2026-12-12T21:30:00Z';
