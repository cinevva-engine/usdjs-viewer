import curatedFtlab from '../../usdjs/test/corpus/curated-ftlab-parser-files.json';
import curatedUsdwg from '../../usdjs/test/corpus/curated-usdwg-parser-files.json';
import curatedNvidia from '../../usdjs/test/corpus/curated-nvidia-omniverse-scene-templates.json';

type Curated = { files?: string[] };

function normalizeFiles(files: unknown): string[] {
    if (!Array.isArray(files)) return [];
    return files.filter((x) => typeof x === 'string');
}

export type CorpusGroup = {
    id: string;
    label: string;
    files: string[];
};

export const CORPUS_GROUPS: CorpusGroup[] = [
    {
        id: 'ftlab',
        label: 'ft-lab/sample_usd (curated)',
        files: normalizeFiles((curatedFtlab as Curated).files),
    },
    {
        id: 'usdwg',
        label: 'usd-wg/assets (official)',
        files: normalizeFiles((curatedUsdwg as Curated).files),
    },
    {
        id: 'nvidia',
        label: 'NVIDIA Omniverse (Scene Templates)',
        files: normalizeFiles((curatedNvidia as Curated).files),
    },
];


