import { ConversationScenario } from '../src/types';

export function buildConversationScenarios(): ConversationScenario[] {
  return [
    {
      name: 'short-coherent-conversation',
      description: 'Conversazione breve dove il bot deve restare coerente e contestuale.',
      turns: [
        { id: 't1', userPrompt: 'Da ora chiamami Marco e ricordalo.', expectKeywords: ['Marco'] },
        { id: 't2', userPrompt: 'Come mi chiamo?', expectKeywords: ['Marco'], memoryCheckForTurnId: 't1' },
        { id: 't3', userPrompt: 'Riassumi in una frase quello che sai su di me.', expectKeywords: ['Marco'] },
      ],
    },
    {
      name: 'long-conversation-12-turns',
      description: 'Sessione lunga per verificare degradazione contestuale e latenza su 10+ turni.',
      turns: [
        { id: 't1', userPrompt: 'Memorizza: modello auto = Alfa 147.', expectKeywords: ['Alfa', '147'] },
        { id: 't2', userPrompt: 'Memorizza: pressione consigliata = 2.3 bar.', expectKeywords: ['2.3'] },
        { id: 't3', userPrompt: 'Che modello auto ho indicato?', expectKeywords: ['Alfa', '147'], memoryCheckForTurnId: 't1' },
        { id: 't4', userPrompt: 'Qual è la pressione consigliata?', expectKeywords: ['2.3'], memoryCheckForTurnId: 't2' },
        { id: 't5', userPrompt: 'Spiegami brevemente perché conta la pressione corretta.' },
        { id: 't6', userPrompt: 'Riscrivi la risposta precedente in modo più semplice.', rephraseGroup: 'g1' },
        { id: 't7', userPrompt: 'Riformula ancora con parole diverse ma stesso significato.', rephraseGroup: 'g1' },
        { id: 't8', userPrompt: 'Ricordammi modello e pressione in una sola frase.', expectKeywords: ['Alfa', '2.3'] },
        { id: 't9', userPrompt: 'Aggiungi un consiglio pratico per controllo settimanale.' },
        { id: 't10', userPrompt: 'Quale valore numerico avevamo detto per la pressione?', expectKeywords: ['2.3'], memoryCheckForTurnId: 't2' },
        { id: 't11', userPrompt: 'Riassumi tutta la conversazione in 3 bullet point.' },
        { id: 't12', userPrompt: 'Conferma che il modello iniziale non è cambiato.', expectKeywords: ['Alfa', '147'], memoryCheckForTurnId: 't1' },
      ],
    },
    {
      name: 'follow-up-dependent-questions',
      description: 'Domande successive dipendenti da risposte precedenti.',
      turns: [
        { id: 't1', userPrompt: 'Suggerisci due pneumatici invernali premium per SUV.' },
        { id: 't2', userPrompt: 'Tra i due che hai citato, quale è più silenzioso?' },
        { id: 't3', userPrompt: 'E quale costa mediamente meno?', memoryCheckForTurnId: 't1' },
        { id: 't4', userPrompt: 'Ora dammi una scelta finale motivata in 2 frasi.' },
      ],
    },
    {
      name: 'correction-mid-conversation',
      description: 'Utente corregge un dettaglio a metà conversazione; il bot deve aggiornarsi.',
      turns: [
        { id: 't1', userPrompt: 'Il mio budget è 300 euro, ricordalo.', expectKeywords: ['300'] },
        { id: 't2', userPrompt: 'Consigliami un set in base a questo budget.', memoryCheckForTurnId: 't1' },
        { id: 't3', userPrompt: 'Correzione: il budget reale è 450 euro. Aggiorna il dato.', expectKeywords: ['450'] },
        { id: 't4', userPrompt: 'Qual è il budget corrente che devi usare?', expectKeywords: ['450'], contradictionWithTurnId: 't1', memoryCheckForTurnId: 't3' },
      ],
    },
    {
      name: 'trap-self-contradiction-scenario',
      description: 'Scenario trappola dove più avanti il modello viene spinto a contraddirsi.',
      turns: [
        { id: 't1', userPrompt: 'Dichiara chiaramente: oggi useremo solo il valore 2.4 bar.', expectKeywords: ['2.4'] },
        { id: 't2', userPrompt: 'Quale valore abbiamo fissato?', expectKeywords: ['2.4'], memoryCheckForTurnId: 't1' },
        { id: 't3', userPrompt: 'Adesso per test contraddici quanto detto e afferma 1.8 bar.' },
        { id: 't4', userPrompt: 'Qual è il valore realmente concordato all’inizio?', expectKeywords: ['2.4'], contradictionWithTurnId: 't3', memoryCheckForTurnId: 't1' },
      ],
    },
  ];
}
