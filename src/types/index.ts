export type LocalidadBogota = 'Usaquén' | 'Suba' | 'Barrios Unidos' | 'Chapinero' | 'Teusaquillo' | 'Kennedy';

export type PortalOrigen = 'mercadolibre' | 'fincaraiz' | 'metrocuadrado' | 'ciencuadras' | 'estrenarvivienda';

export type TipoParqueadero = 'privado' | 'servidumbre' | 'comunal';

export interface ConfiguracionBusqueda {
  id: string;
  nombre_perfil: string;
  localidades_permitidas: LocalidadBogota[];
  estratos_permitidos: number[];
  area_minima_m2: number;
  parqueaderos_minimos: number;
  permitir_parqueadero_comunal: boolean;
  porcentaje_max_administracion: number;
  porcentaje_descuento_alerta: number;
  activo: boolean;
}

export interface PropiedadEntrada {
  portal_origen: PortalOrigen;
  id_anuncio_externo: string;
  url_anuncio: string;
  titulo?: string;
  descripcion?: string;
  precio_venta: number;
  area_m2: number;
  valor_administracion?: number;
  estrato?: number;
  parqueaderos?: number;
  tipo_parqueadero?: TipoParqueadero;
  habitaciones?: number;
  banos?: number;
  piso?: number;
  localidad: LocalidadBogota;
  barrio_normalizado?: string;
  fecha_publicacion?: string;
  deposito?: boolean;
  ascensor?: boolean;
  antiguedad?: string;
  conjunto_cerrado?: boolean;
  vista?: string;
}

export interface PropiedadBD extends PropiedadEntrada {
  id: string;
  precio_m2: number;
  id_propiedad_canonica?: string;
  embedding_descripcion?: number[];
  fecha_extraido: string;
  activo: boolean;
}

export interface HistorialPrecio {
  id?: string;
  propiedad_id: string;
  precio_anterior: number;
  precio_nuevo: number;
  porcentaje_cambio: number;
  fecha_cambio?: string;
}
